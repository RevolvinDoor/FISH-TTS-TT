import { BrowserAudioStore, synthesizeBrowser } from './browser-audio.mjs';
import { DEFAULTS, extract, resolveVoice, normalizeSpeakerName, selectLanguage, upgradeWorldbook, blocks, dialogueRecords, segmentFromBlock, isBlocked, buildCharacterFormWorldbookEntry } from './core.mjs';
import { SpeechQueue } from './player.mjs';
import { SynthesisQueue } from './synthesis.mjs';
import { installInline } from './inline.mjs';
import { installPromptRegex } from './prompt-regex.mjs';
import { defaultVoicePreview, voicePreview, voicePreviewText } from './preview.mjs';

const ctx = () => SillyTavern.getContext();
const KEY = 'fish_dialogue_v1';
const settings = ctx().extensionSettings[KEY] = { ...structuredClone(DEFAULTS), ...ctx().extensionSettings[KEY] };
if (settings.schemaVersion !== 110) {
    settings.fallback = false;
    settings.schemaVersion = 110;
    ctx().saveSettingsDebounced();
}
settings.voicePresets ||= {};
settings.currentVoicePreset ||= '';
settings.voiceLibrary ||= [];
settings.voicePreviewMode ||= 'greeting';
settings.voicePreviewTexts = { ...DEFAULTS.voicePreviewTexts, ...(settings.voicePreviewTexts || {}) };
settings.browserLibraryId ||= crypto.randomUUID();
ctx().saveSettingsDebounced();
const browserStore = new BrowserAudioStore(settings.browserLibraryId);
let apiKey = settings.savedApiKey || ''; // Saved only on explicit user action.
const audio = new Audio(); audio.preload = 'auto';
const logs = [], seen = new Map();
const voiceWarned = new Map();
let worldModule;
let inline, libraryEntries = [];
const voicePickers = new Set();
let librarySyncTimer = 0;
const root = document.createElement('section'); root.id = 'fish-dialogue';
root.innerHTML = `
<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0"><b>Fish 对话音声</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><small>版本 1.6.0</small>
<div class="fa-status" id="fa-status">就绪</div>
<label class="checkbox_label"><input id="fa-auto" type="checkbox"> 新回复自动配音</label><small>按顺序生成对白并保存到本地，不自动播放。</small>
<div class="fa-row"><button id="fa-latest">聊天序号音频生成</button></div>
<label>聊天文本序号（留空为最新回复）<input id="fa-message" type="number" min="0" class="text_pole"></label>
<details open><summary>连接设置</summary>
<label>Base URL（服务根地址，末尾 /v1 也可）<input id="fa-base" class="text_pole"></label>
<label>API Key<input id="fa-key" class="text_pole" type="password" autocomplete="off"></label>
<button id="fa-key-save">保存API KEY</button><small>保存到账户设置；留空保存可清除。账户设置备份可能包含此密钥。</small>
<label>语音引擎<input id="fa-model" class="text_pole" type="text" placeholder="s2.1-pro-free"></label>
<label class="checkbox_label"><input id="fa-direct-fetch" type="checkbox"> 前端直连 / 本地代理（TauriTavern 勾选此项，绕过 CORS 代理）</label>
<small>原生酒馆依赖 enableCorsProxy；TauriTavern 或配合本地反代（如 127.0.0.1）请勾选直连。</small>
</details>
<details open><summary>语言与世界书</summary>
<label>专用世界书名称<input id="fa-book" class="text_pole"></label>
<label>输出语言<select id="fa-language"><option value="orig">原文（关闭配音世界书）</option><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option></select></label>
<div class="fa-row"><button id="fa-apply-language">应用语言</button><button id="fa-install-book">安装 / 挂载世界书</button><button id="fa-upgrade-book">升级世界书</button><button id="fa-add-regex">添加正则</button></div>
<small>语言选择在“应用”成功后生效；只改变下一次聊天生成的提示词，旧消息不会自动翻译。挂载为全局世界书，语言条目为该账户所有聊天共享。</small>
<label class="checkbox_label"><input id="fa-fallback" type="checkbox"> 无标记时兼容普通双引号</label>
</details>
<details open><summary>角色音色</summary>
<div class="fa-default-heading"><label for="fa-default">默认音色 ID</label><button id="fa-preview-default" type="button">试听默认音色</button></div><input id="fa-default" class="text_pole">
<label class="checkbox_label"><input id="fa-block-enabled" type="checkbox"> 启用角色屏蔽</label>
<label>屏蔽角色名字（每行一个）<textarea id="fa-block-names" class="text_pole" rows="2" placeholder="例如：屏蔽角色名字"></textarea></label>
<small>屏蔽只影响语音，中文对白照常显示。修改后立即停止当前队列。</small>
<small>角色名自动归一化全角/半角、大小写和空白；编辑后自动保存，空白音色使用默认音色。</small>
<div id="fa-voices"></div><button id="fa-add">添加角色</button><button id="fa-save-voices">保存角色绑定</button><button id="fa-reload-voices">重新加载绑定</button>
</details>
<details open><summary>音色库</summary>
<label>试听模式<select id="fa-voice-preview-mode"><option value="greeting">主类语言问候</option><option value="onomatopoeia">拟声词</option></select></label>
<details><summary>试听文字设置</summary>
<label>中文试听文字<input id="fa-preview-text-zh" class="text_pole"></label>
<label>日语试听文字<input id="fa-preview-text-ja" class="text_pole"></label>
<label>英语试听文字<input id="fa-preview-text-en" class="text_pole"></label>
<label>拟声词试听文字<input id="fa-preview-text-ono" class="text_pole"></label>
</details>
<small>音色库按中文 / 日语 / 英语三大主类管理；下拉选项只显示名称，鼠标悬停可查看完整 ID。</small>
<div id="fa-library-rows"></div>
<button id="fa-library-add">添加音色</button>
<label>批量粘贴音色（主类标题行可选，可写“日语/低沉”作为小类）<textarea id="fa-library-batch" class="text_pole" rows="5" placeholder="日语&#10;70b6d85050654441b5280bc0808bab11 自用低沉&#10;&#10;中文&#10;1a4942a3672d4420b23e3c9c97015e3d 姐姐"></textarea></label>
<div class="fa-row"><button id="fa-library-batch-apply">解析并加入</button><button id="fa-library-export">导出音色库</button><button id="fa-library-import">导入音色库</button><input id="fa-library-import-file" type="file" accept="application/json,.json" hidden></div>
<small>音色库独立于音声预设；预设只保存默认音色和角色绑定（含特殊形态）。</small>
</details>
<details open><summary>音声预设</summary>
<label>预设名称<input id="fa-preset-name" class="text_pole" placeholder="例如：日常角色包"></label>
<label>选择预设<select id="fa-preset-select"><option value="">选择预设…</option></select></label>
<div class="fa-row"><button id="fa-preset-apply">应用预设</button><button id="fa-preset-save">保存为预设</button><button id="fa-preset-rename">重命名</button><button id="fa-preset-delete">删除预设</button></div>
<div class="fa-row"><button id="fa-preset-export">导出预设</button><button id="fa-preset-import">导入预设</button><input id="fa-preset-import-file" type="file" accept="application/json,.json" hidden></div>
<small>音声预设只包含默认音色和全部角色绑定（含特殊形态）；应用会覆盖当前角色音色并停止队列。连接、语言、屏蔽名单不随预设变化。</small>
</details>
<details><summary>合成进度 / 已生成语音 <span class="fa-version">本地保存</span></summary>
<div id="fa-progress-summary" role="status">尚无合成任务</div><progress id="fa-progress-bar" max="1" value="0"></progress>
<div class="fa-row"><button id="fa-cancel-generation">取消合成队列</button></div>
<small>字节数来自浏览器实际接收量。上游不提供总长度时不显示虚构百分比。</small><div id="fa-progress-list"></div>
<div class="fa-row"><button id="fa-library-refresh">刷新语音列表</button></div>
<small id="fa-library-path">保存在当前浏览器中；清除网站数据会删除音频。可逐条下载。</small>
<label>最大保留数量（1–10000）<input id="fa-limit" type="number" min="1" max="10000" value="200" class="text_pole"></label>
<button id="fa-limit-save">保存数量并清理超出的最旧音频</button>
<small>只清理本插件保存的文件。被清理的句子再次点击时可重新生成。</small>
<div id="fa-library-list"></div>
</details>
<details><summary>日志</summary><div class="fa-row"><button id="fa-log-export">导出日志</button><button id="fa-log-clear">清空日志</button></div><pre id="fa-logs"></pre></details>
</div></div>`;
(document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings') || document.body).append(root);
for (const button of root.querySelectorAll('button')) button.classList.add('menu_button');
root.querySelector('.inline-drawer-header').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}});
const $ = id => id === 'audio' ? audio : root.querySelector('#fa-' + id);
function save() { ctx().saveSettingsDebounced(); }
function log(level, text) {
    let safe = String(text);
    for (const key of [apiKey,settings.savedApiKey]) if(key) safe = safe.replaceAll(key, '[REDACTED]');
    safe = safe.replace(/sk-fish-[A-Za-z0-9_-]+/g,'[REDACTED]');
    logs.push(`${new Date().toISOString()} ${level} ${safe}`);
    if (logs.length > 300) logs.shift();
    $('logs').textContent = logs.join('\n');
    if (level === 'ERROR' || level === 'WARN') $('status').textContent = safe;
    if (level === 'ERROR') showError(safe);
}
let lastError = '', lastErrorAt = 0;
function showError(message) {
    if (message === lastError && Date.now()-lastErrorAt < 4000) return;
    lastError=message; lastErrorAt=Date.now();
    const dialog=document.createElement('dialog'); dialog.className='fa-error-dialog';
    const title=document.createElement('h3'); title.textContent='Fish 对话音声：出错了';
    const body=document.createElement('p'); body.textContent=message;
    const close=document.createElement('button'); close.className='menu_button'; close.textContent='关闭'; close.onclick=()=>dialog.close();
    dialog.append(title,body,close); document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
}
function askConfirm(message) {
    return new Promise(resolve => {
        const dialog=document.createElement('dialog'); dialog.className='fa-error-dialog';
        const body=document.createElement('p'); body.textContent=message;
        const row=document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.style.marginTop='12px';
        const ok=document.createElement('button'); ok.className='menu_button'; ok.textContent='继续';
        const cancel=document.createElement('button'); cancel.className='menu_button'; cancel.textContent='取消';
        let confirmed=false;
        ok.onclick=()=>{confirmed=true;dialog.close();};
        cancel.onclick=()=>dialog.close();
        row.append(ok,cancel); dialog.append(body,row); document.body.append(dialog);
        dialog.addEventListener('close',()=>{dialog.remove();resolve(confirmed);},{once:true});
        dialog.showModal();
    });
}
function click(id, fn) {
    $(id).addEventListener('click', async () => {
        $(id).disabled = true;
        try { await fn(); } catch (e) { log('ERROR', e.message); }
        finally { $(id).disabled = false; }
    });
}
async function api(action,input={},signal,update) {
    if(action==='tts')return synthesizeBrowser(input,apiKey,browserStore,signal,update);
    if(action==='library')return browserStore.list();
    if(action==='library/limit')return browserStore.setLimit(input.maxFiles);
    if(action==='audio'){
        const blob=await browserStore.read(input.id);
        if(!blob)throw Error('音频已清理；请点击对应对白重新生成');
        return blob;
    }
    throw Error('不支持的本地操作');
}
const generator = new SynthesisQueue({synthesize:synthesizeRaw, changed:renderProgress});
function renderProgress() {
    const tasks = generator.tasks;
    for(const task of tasks) if(task.status==='failed' && !task.errorReported){task.errorReported=true;log('ERROR',task.error);}
    const counts = {ready:0,failed:0,canceled:0};
    for(const t of tasks) if(t.status in counts) counts[t.status]++;
    $('progress-summary').textContent = tasks.length ? '已就绪 '+counts.ready+' / '+tasks.length+' · 失败 '+counts.failed+' · 取消 '+counts.canceled+(generator.memoryPaused?' · 缓冲已满，播放后继续合成':'') : '尚无合成任务';
    $('progress-bar').max=Math.max(1,tasks.length); $('progress-bar').value=counts.ready+counts.failed+counts.canceled;
    const rows=tasks.slice(-100).map(t=>{
        const row=document.createElement('div');row.className='fa-job';
        const title=document.createElement('span');title.textContent=(t.item.speaker||'默认')+' · 第 '+((t.item.block||0)+1)+' 段';
        const state=document.createElement('small');
        const labels={queued:'等待请求',requesting:'等待 API 响应',receiving:'接收音频',saving:'保存音频',ready:t.cacheSource==='disk'?'本地命中':'音频就绪',failed:'失败',canceled:'已取消'};
        const elapsed=t.startedAt?Math.max(0,Math.round(((t.finishedAt||Date.now())-t.startedAt)/1000)):0;
        const bytes=t.receivedBytes ? ' · '+(t.receivedBytes/1024).toFixed(1)+' KB'+(t.totalBytes?' / '+(t.totalBytes/1024).toFixed(1)+' KB':'（总大小未知）'):'';
        state.textContent=labels[t.status]+' · '+elapsed+' 秒'+bytes+(t.error?' · '+t.error:'');
        row.append(title,state);return row;
    });
    $('progress-list').replaceChildren(...rows);inline?.schedule();
}
function stopAll() { generator.cancel(); queue.stop(); }
click('cancel-generation',()=>generator.cancel());
const progressTimer=setInterval(()=>{if(generator.running)renderProgress();},1000);
const queue = new SpeechQueue({
    audio: $('audio'), log,
    changed(q) {
        $('status').textContent = q.error || (q.running ? `角色：${q.current?.speaker || '默认'} · 剩余 ${q.items.length} 句${q.paused ? ' · 已暂停' : ''}` : '就绪 / 队列结束');
        $('preview-default').textContent=q.running && q.current?.preview && q.current.previewContext === 'default'?'停止试听':'试听默认音色';
        inline?.schedule();
    },
    async synthesize(item, signal) {
        if (isBlocked(item.speaker, settings)) throw new Error('该角色已屏蔽');
        if (item.libraryId) return api('audio', {id:item.libraryId}, signal);
        item.task ||= generator.submit(item);
        return generator.take(item.task, signal);
    },
});
click('preview-default',()=>{
    if(queue.running && queue.current?.preview && queue.current.previewContext === 'default'){queue.stop();return;}
    const item=defaultVoicePreview(settings);queue.stop();queue.enqueue([item]);
});
async function synthesizeRaw(item, signal, update) {
        if (isBlocked(item.speaker, settings)) throw new Error('该角色已屏蔽，不会向 API 发送对白');
        
        // Message identities are persisted only when audio is requested, not during rendering.
        if (item.messageRef) {
            const c = ctx();
            if (!c.chat.includes(item.messageRef)) throw new Error('消息已切换，取消生成');
            const needsSave = !c.chatMetadata.fish_dialogue_chat_id || !item.messageRef.extra?.fish_dialogue?.id;
            c.chatMetadata.fish_dialogue_chat_id ||= (globalThis.crypto?.randomUUID?.() || c.uuidv4());
            item.messageRef.extra ||= {};
            item.messageRef.extra.fish_dialogue ||= {};
            item.messageRef.extra.fish_dialogue.id ||= (globalThis.crypto?.randomUUID?.() || c.uuidv4());
            item.messageRef.extra.fish_dialogue.language ||= item.language;
            const revision = await digest(item.messageRef.mes);
            item.link = { chat: c.chatMetadata.fish_dialogue_chat_id, message: item.messageRef.extra.fish_dialogue.id, revision, block: item.block };
            if (needsSave) await c.saveChat();
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        }
        const payload = { text: item.text, speaker: item.speaker, language: item.language, voice: item.voice,
            model: item.model, baseUrl: item.baseUrl, directFetch: item.directFetch, link: item.link, persist: true, jobId: globalThis.crypto?.randomUUID?.() || ctx().uuidv4() };
        // Disk is authoritative for retention; local cache is not used to recreate a deleted file.
        const start = performance.now();
        log('INFO', `读取或合成：音色 ${item.voice || '(未设置)'} · ${item.model}，${Array.from(item.text).length} 字符`);
        const blob = await api('tts', payload, signal, update);
        update({cacheSource:payload.cacheSource});
        item.assetId = payload.assetId;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        log('INFO', `${payload.cacheSource === 'disk' ? '本地音频命中' : '合成并保存完成'}：${Math.round(performance.now() - start)} ms，${blob.size} 字节`);
        return blob;
}

function source() {
    const chat = ctx().chat;
    const val = $('message').value;
    const id = val === '' ? chat.findLastIndex(m => !m.is_user && !m.is_system) : Number(val);
    const message = chat[id];
    if (!Number.isInteger(id) || !message || message.is_user || message.is_system) throw new Error('没有可播放的 AI 消息');
    return { id, message };
}
async function digest(text) {
    if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
    // LAN HTTP can lack WebCrypto. This is only a revision hint; the server hashes exact speech and identity.
    let a = 2166136261, b = 5381;
    for (const ch of String(text)) { a = Math.imul(a ^ ch.codePointAt(0), 16777619); b = Math.imul(b, 33) ^ ch.codePointAt(0); }
    return `local-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${text.length}`;
}
function parsed(text, speaker, language = settings.language) {
    const result = extract(text, { ...settings, language, speaker });
    result.warnings.forEach(w => log('WARN', w));
    log('INFO', `提取到 ${result.segments.length} 段 ${settings.language} 对话`);
    const allowed = result.segments.filter(s => !isBlocked(s.speaker, settings));
    if (allowed.length !== result.segments.length) log('INFO', `角色屏蔽：跳过 ${result.segments.length - allowed.length} 段，不发送 API`);
    return allowed;
}
function warnUnboundVoice(speaker) {
    const name = String(speaker || '').trim();
    if (!name) return;
    const key = normalizeSpeakerName(name);
    if (voiceWarned.has(key)) return;
    if (voiceWarned.size > 200) voiceWarned.clear();
    voiceWarned.set(key, true);
    log('WARN', `角色【${name}】未匹配到专属音色，将使用默认音色`);
}
function enqueue(segments, replace = false, eager = false) {
    const items = segments.filter(s => !isBlocked(s.speaker, settings)).map(s => {
        const resolved = resolveVoice(s, settings);
        if (resolved.matched === 'default' || resolved.matched === 'none') warnUnboundVoice(s.speaker);
        return { ...s, voice: resolved.voice, model: settings.model, baseUrl: settings.baseUrl, directFetch: settings.directFetch };
    });
    if (items.some(x => !x.voice)) throw new Error('有角色未绑定音色，且没有默认音色；请先填写音色 ID');
    if (!items.length) return;
    if (queue.items.length + items.length > 100 && !replace) throw new Error('等待队列超过 100 句，请先播放或停止');
    if (replace) queue.stop();
    if (eager) for (const item of items) item.task = generator.submit(item);
    queue.enqueue(items);
}
function bind(id, name, checkbox = false) {
    $(id)[checkbox ? 'checked' : 'value'] = settings[name];
    $(id).addEventListener(checkbox ? 'change' : 'input', () => {
        const value = checkbox ? $(id).checked : $(id).value.trim();
        settings[name] = value; save();
        if (['baseUrl', 'directFetch', 'model', 'defaultVoice'].includes(name)) { stopAll(); if (name === 'defaultVoice') voiceWarned.clear(); }
        if (name === 'auto' && !value) stopAll();
        if (name === 'blockEnabled' || name === 'blockedNames' || name === 'fallback') { stopAll(); inline?.schedule(); }
    });
}
bind('auto', 'auto', true); bind('fallback', 'fallback', true);
bind('block-enabled', 'blockEnabled', true); bind('block-names', 'blockedNames');
if (typeof settings.model !== 'string' || !settings.model.trim()) { settings.model=DEFAULTS.model; save(); }
bind('direct-fetch', 'directFetch', true); bind('base', 'baseUrl'); bind('model', 'model'); bind('book', 'book'); bind('default', 'defaultVoice');
const VOICE_CATEGORY_KEYS = Object.freeze(['zh', 'ja', 'en']);
const VOICE_CATEGORY_LABELS = Object.freeze({ zh: '中文', ja: '日语', en: '英语' });
const VOICE_CATEGORY_BY_LABEL = Object.freeze({ 中文: 'zh', 日语: 'ja', 英语: 'en' });
function normalizeLibraryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = String(entry.id || '').trim();
    const name = String(entry.name || '').trim();
    const category = VOICE_CATEGORY_KEYS.includes(entry.category) ? entry.category : 'zh';
    const sub = String(entry.sub || '').trim();
    return id && name ? { id, name, category, sub } : null;
}
function sortVoiceLibrary(list) {
    return [...list].sort((a, b) => (VOICE_CATEGORY_KEYS.indexOf(a.category) - VOICE_CATEGORY_KEYS.indexOf(b.category))
        || a.sub.localeCompare(b.sub, 'zh') || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id));
}
function formatLibraryLabel(entry) {
    return entry.sub ? `${entry.name}（${VOICE_CATEGORY_LABELS[entry.category]} / ${entry.sub}）` : `${entry.name}（${VOICE_CATEGORY_LABELS[entry.category]}）`;
}
function attachVoicePicker(input) {
    if (input.dataset.voicePicker === '1') return;
    const wrapper = document.createElement('div'); wrapper.className = 'fa-voice-picker';
    const arrow = document.createElement('span'); arrow.className = 'fa-voice-picker-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '▾';
    const menu = document.createElement('div'); menu.className = 'fa-voice-lib-menu'; menu.hidden = true;
    input.parentNode.insertBefore(wrapper, input); wrapper.append(input, arrow, menu);
    input.dataset.voicePicker = '1';
    const picker = { input, wrapper, menu, open: false };
    voicePickers.add(picker);
    function renderOptions() {
        menu.replaceChildren();
        const query = input.value.trim().toLocaleLowerCase();
        const grouped = new Map(VOICE_CATEGORY_KEYS.map(key => [key, []]));
        for (const entry of sortVoiceLibrary(settings.voiceLibrary || [])) {
            if (query && !(entry.id.toLocaleLowerCase().includes(query) || entry.name.toLocaleLowerCase().includes(query) || entry.sub.toLocaleLowerCase().includes(query))) continue;
            grouped.get(entry.category).push(entry);
        }
        let any = false;
        for (const key of VOICE_CATEGORY_KEYS) {
            const entries = grouped.get(key);
            if (!entries.length) continue;
            any = true;
            const group = document.createElement('div'); group.className = 'fa-voice-lib-group'; group.textContent = VOICE_CATEGORY_LABELS[key];
            menu.append(group);
            for (const entry of entries) {
                const option = document.createElement('div'); option.className = 'fa-voice-lib-option'; option.tabIndex = 0; option.title = entry.id;
                const label = document.createElement('span'); label.textContent = formatLibraryLabel(entry);
                option.append(label);
                option.addEventListener('mousedown', e => e.preventDefault());
                option.addEventListener('click', () => {
                    input.value = entry.id;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    picker.open = false; menu.hidden = true; input.blur();
                });
                option.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); option.click(); }
                });
                menu.append(option);
            }
        }
        if (!any) {
            const empty = document.createElement('div'); empty.className = 'fa-voice-lib-empty'; empty.textContent = '没有匹配的音色，可直接输入 ID';
            menu.append(empty);
        }
    }
    function show() {
        if (!(settings.voiceLibrary || []).length) { picker.open = false; menu.hidden = true; return; }
        renderOptions(); picker.open = true; menu.hidden = false;
    }
    function hide() { picker.open = false; menu.hidden = true; }
    input.addEventListener('focus', show);
    input.addEventListener('click', show);
    input.addEventListener('input', () => { if (picker.open) renderOptions(); });
    input.addEventListener('blur', () => setTimeout(() => { if (picker.open) hide(); }, 160));
    wrapper.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); hide(); input.blur(); }
        if (e.key === 'ArrowDown' && !menu.hidden) {
            e.preventDefault();
            const first = menu.querySelector('.fa-voice-lib-option');
            first?.focus();
        }
    });
    menu.addEventListener('keydown', e => {
        const options = [...menu.querySelectorAll('.fa-voice-lib-option')];
        if (!options.length) return;
        const current = options.indexOf(document.activeElement);
        let next = -1;
        if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % options.length;
        else if (e.key === 'ArrowUp') next = current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = options.length - 1;
        if (next >= 0) { e.preventDefault(); options[next].focus(); }
    });
    picker.refresh = renderOptions;
}
function refreshVoicePickers() {
    for (const picker of [...voicePickers]) {
        if (!picker.wrapper.isConnected) { voicePickers.delete(picker); continue; }
        picker.refresh();
    }
}
function readLibraryRow(row) {
    const id = row.querySelector('.fa-lib-id')?.value.trim() || '';
    const name = row.querySelector('.fa-lib-name')?.value.trim() || '';
    const category = row.querySelector('.fa-lib-category')?.value || 'zh';
    const sub = row.querySelector('.fa-lib-sub')?.value.trim() || '';
    return id && name ? { id, name, category, sub } : null;
}
function addLibraryRow(entry = {}) {
    const row = document.createElement('div'); row.className = 'fa-lib-row';
    const categorySelect = document.createElement('select'); categorySelect.className = 'fa-lib-category';
    for (const key of VOICE_CATEGORY_KEYS) {
        const option = document.createElement('option'); option.value = key; option.textContent = VOICE_CATEGORY_LABELS[key];
        categorySelect.append(option);
    }
    categorySelect.value = VOICE_CATEGORY_KEYS.includes(entry.category) ? entry.category : 'zh';
    const subInput = document.createElement('input'); subInput.className = 'text_pole fa-lib-sub'; subInput.placeholder = '小类（如：低沉）'; subInput.value = entry.sub || '';
    const nameInput = document.createElement('input'); nameInput.className = 'text_pole fa-lib-name'; nameInput.placeholder = '名称（如：自用低沉）'; nameInput.value = entry.name || '';
    const idInput = document.createElement('input'); idInput.className = 'text_pole fa-lib-id'; idInput.placeholder = '音色 ID'; idInput.value = entry.id || '';
    const previewBtn = document.createElement('button'); previewBtn.className = 'menu_button'; previewBtn.textContent = '试听';
    const defaultBtn = document.createElement('button'); defaultBtn.className = 'menu_button'; defaultBtn.textContent = '设为默认';
    const deleteBtn = document.createElement('button'); deleteBtn.className = 'menu_button'; deleteBtn.textContent = '×'; deleteBtn.title = '删除此音色';
    for (const el of [categorySelect, subInput, nameInput, idInput]) {
        el.addEventListener('input', scheduleLibrarySync);
        el.addEventListener('change', scheduleLibrarySync);
    }
    previewBtn.onclick = async () => {
        try {
            const itemEntry = readLibraryRow(row);
            if (!itemEntry) throw new Error('请先填写完整的音色 ID 和名称');
            queue.stop();
            queue.enqueue([voicePreview({
                voice: itemEntry.id, language: itemEntry.category,
                text: voicePreviewText(itemEntry.category, settings), previewContext: 'library',
            }, settings)]);
        } catch (e) { log('ERROR', e.message); }
    };
    defaultBtn.onclick = () => {
        const itemEntry = readLibraryRow(row);
        if (!itemEntry) throw new Error('请先填写完整的音色 ID 和名称');
        stopAll();
        settings.defaultVoice = itemEntry.id;
        voiceWarned.clear();
        save();
        $('default').value = itemEntry.id;
        refreshVoicePickers();
        log('INFO', `已把音色库【${formatLibraryLabel(itemEntry)}】设为默认音色`);
    };
    deleteBtn.onclick = () => { row.remove(); syncLibrary(); };
    row.append(categorySelect, subInput, nameInput, idInput, previewBtn, defaultBtn, deleteBtn);
    $('library-rows').append(row);
    return row;
}
function syncLibrary() {
    const list = [];
    for (const row of $('library-rows').children) {
        const entry = readLibraryRow(row);
        if (entry) list.push(entry);
    }
    settings.voiceLibrary = sortVoiceLibrary(list);
    save();
    refreshVoicePickers();
}
function scheduleLibrarySync() {
    clearTimeout(librarySyncTimer);
    librarySyncTimer = setTimeout(() => { librarySyncTimer = 0; syncLibrary(); }, 350);
}
function renderLibrary() {
    clearTimeout(librarySyncTimer); librarySyncTimer = 0;
    $('library-rows').replaceChildren();
    for (const entry of sortVoiceLibrary(settings.voiceLibrary || [])) addLibraryRow(entry);
    refreshVoicePickers();
}
function parseVoiceLibraryText(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let category = '', sub = '';
    const entries = [], invalid = [];
    for (const line of lines) {
        const heading = /^(中文|日语|英语)(?:\s*[\/／]\s*(.*))?$/.exec(line);
        if (heading) { category = VOICE_CATEGORY_BY_LABEL[heading[1]]; sub = (heading[2] || '').trim(); continue; }
        const match = /^(\S+)\s+(.+)$/.exec(line);
        const entry = category && match ? normalizeLibraryEntry({ id: match[1], name: match[2], category, sub }) : null;
        if (entry) entries.push(entry);
        else invalid.push(line);
    }
    return { entries, invalid };
}
function mergeVoiceLibrary(incoming) {
    const target = new Map((settings.voiceLibrary || []).map(entry => [entry.id, entry]));
    let added = 0, overwritten = 0;
    for (const entry of incoming) {
        if (target.has(entry.id)) overwritten++;
        else added++;
        target.set(entry.id, entry);
    }
    return { added, overwritten, list: [...target.values()] };
}
async function applyVoiceLibraryMerge(incoming, note = '') {
    if (!incoming.length) throw new Error('没有可加入的有效音色');
    const { added, overwritten, list } = mergeVoiceLibrary(incoming);
    const message = `音色库将新增 ${added} 条、覆盖 ${overwritten} 条${note}，是否继续？`;
    if (!await askConfirm(message)) return false;
    settings.voiceLibrary = sortVoiceLibrary(list);
    save(); renderLibrary();
    return true;
}
attachVoicePicker($('default'));
renderLibrary();
$('voice-preview-mode').value = settings.voicePreviewMode;
$('voice-preview-mode').addEventListener('change', () => {
    settings.voicePreviewMode = $('voice-preview-mode').value;
    save(); stopAll();
});
for (const [key, id] of [['zh', 'preview-text-zh'], ['ja', 'preview-text-ja'], ['en', 'preview-text-en'], ['onomatopoeia', 'preview-text-ono']]) {
    $(id).value = settings.voicePreviewTexts[key] || '';
    $(id).addEventListener('input', () => { settings.voicePreviewTexts[key] = $(id).value; save(); });
}
click('library-add', () => addLibraryRow());
click('library-batch-apply', async () => {
    const result = parseVoiceLibraryText($('library-batch').value);
    if (result.invalid.length) log('WARN', `音色库批量解析：${result.invalid.length} 行无法识别或缺少主类标题（${result.invalid.slice(0, 3).join('；')}${result.invalid.length > 3 ? ' 等' : ''}）`);
    if (await applyVoiceLibraryMerge(result.entries, `，另有 ${result.invalid.length} 行无法识别`)) {
        $('library-batch').value = '';
        log('INFO', `音色库批量加入完成：${result.entries.length} 条有效音色`);
    }
});
click('library-export', () => {
    const data = { type: 'fish_dialogue_voice_library', version: 1, voices: sortVoiceLibrary(settings.voiceLibrary || []) };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), 'fish-dialogue-音色库.json');
    log('INFO', `已导出音色库 ${data.voices.length} 条`);
});
click('library-import', () => $('library-import-file').click());
$('library-import-file').addEventListener('change', async () => {
    try {
        const input = $('library-import-file'); const file = input.files?.[0]; input.value = '';
        if (!file) return;
        let parsed;
        try { parsed = JSON.parse(await file.text()); }
        catch (e) { throw new Error('导入文件不是有效 JSON：' + e.message); }
        const rawList = Array.isArray(parsed) ? parsed : (parsed?.voices || parsed?.library || []);
        if (!Array.isArray(rawList)) throw new Error('导入文件中没有可识别的音色列表');
        const incoming = rawList.map(normalizeLibraryEntry).filter(Boolean);
        const skipped = rawList.length - incoming.length;
        if (skipped) log('WARN', `音色库导入：跳过 ${skipped} 条缺少 ID 或名称的记录`);
        if (await applyVoiceLibraryMerge(incoming, `，另有 ${skipped} 条无效`)) {
            log('INFO', `音色库导入完成：${incoming.length} 条`);
        }
    } catch (e) {
        log('ERROR', e.message || '导入音色库失败');
    }
});
$('language').value = settings.language;
$('key').value=apiKey;
$('key').addEventListener('input', () => { stopAll(); apiKey = $('key').value.trim(); });
click('key-save',()=>{settings.savedApiKey=apiKey;save();log('INFO',apiKey?'API Key 已保存到账户设置':'已清除保存的 API Key');});
click('add-regex',async()=>{await installPromptRegex(ctx());log('INFO','已添加 Talk-Emo 提示词过滤正则；立即生效，刷新后可在酒馆正则列表查看。');$('status').textContent='已添加正则：音声段不再发送给 LLM，聊天原文和播放保留';});
function readRoleCard(card, strict) {
    const header = card.querySelector('.fa-voice-header');
    const inputs = header?.querySelectorAll('input') || [];
    const name = inputs[0]?.value.trim() || '';
    const defVoice = inputs[1]?.value.trim() || '';
    const forms = Object.create(null);
    for (const fRow of card.querySelectorAll('.fa-form-row')) {
        const fName = fRow.querySelector('.fa-form-name')?.value.trim() || '';
        const fVoice = fRow.querySelector('.fa-form-voice')?.value.trim() || '';
        const fDesc = fRow.querySelector('.fa-form-desc')?.value.trim() || '';
        if (!fName && !fVoice && !fDesc) continue;
        if (!fName) {
            if (strict) throw new Error('形态名称不能为空');
            continue;
        }
        if (Object.hasOwn(forms, fName)) {
            if (strict) throw new Error(`角色【${name}】的形态【${fName}】重复`);
            continue;
        }
        forms[fName] = { voice: fVoice, desc: fDesc };
    }
    if (!name && !defVoice && !Object.keys(forms).length) return null;
    if (!name) {
        if (strict) throw new Error('角色名不能为空');
        return null;
    }
    return { name, defVoice, forms };
}
function collectVoices(strict = false) {
    const voices = Object.create(null);
    for (const card of $('voices').children) {
        const entry = readRoleCard(card, strict);
        if (!entry) continue;
        if (Object.hasOwn(voices, entry.name)) {
            if (strict) throw new Error(`角色名【${entry.name}】重复`);
            continue;
        }
        voices[entry.name] = Object.keys(entry.forms).length ? { default: entry.defVoice, forms: entry.forms } : entry.defVoice;
    }
    return voices;
}
function syncVoices({ strict = false, stop = false } = {}) {
    const voices = collectVoices(strict);
    settings.voices = voices; save(); voiceWarned.clear();
    if (stop) stopAll();
    return voices;
}
let voiceSyncTimer = 0;
function scheduleVoiceSync() {
    clearTimeout(voiceSyncTimer);
    voiceSyncTimer = setTimeout(() => { voiceSyncTimer = 0; syncVoices({ stop: false }); }, 400);
}
function addVoice(name = '', voiceData = '') {
    const card = document.createElement('div'); card.className = 'fa-voice-card';
    const header = document.createElement('div'); header.className = 'fa-voice-header';
    const nameInput = document.createElement('input'); nameInput.className = 'text_pole'; nameInput.placeholder = '角色名（如：爱丽丝）'; nameInput.value = name;
    const defVoice = typeof voiceData === 'string' ? voiceData : (voiceData?.default || '');
    const voiceInput = document.createElement('input'); voiceInput.className = 'text_pole'; voiceInput.placeholder = '默认音色 ID'; voiceInput.value = defVoice;
    const removeCard = document.createElement('button'); removeCard.className = 'menu_button'; removeCard.textContent = '删除角色';
    nameInput.addEventListener('input', scheduleVoiceSync);
    voiceInput.addEventListener('input', scheduleVoiceSync);
    removeCard.onclick = () => { card.remove(); syncVoices({ stop: false }); };
    header.append(nameInput, voiceInput, removeCard);
    attachVoicePicker(voiceInput);

    const formsContainer = document.createElement('div'); formsContainer.className = 'fa-forms-container';
    function addFormRow(formName = '', fVoice = '', fDesc = '') {
        const fRow = document.createElement('div'); fRow.className = 'fa-form-row';
        const fNameInput = document.createElement('input'); fNameInput.className = 'text_pole fa-form-name'; fNameInput.placeholder = '形态（如：黑化）'; fNameInput.value = formName;
        const fVoiceInput = document.createElement('input'); fVoiceInput.className = 'text_pole fa-form-voice'; fVoiceInput.placeholder = '该形态音色 ID'; fVoiceInput.value = fVoice;
        const fDescInput = document.createElement('input'); fDescInput.className = 'text_pole fa-form-desc'; fDescInput.placeholder = '触发情境（如：黑化暴走时）'; fDescInput.value = fDesc;
        const delForm = document.createElement('button'); delForm.className = 'menu_button'; delForm.textContent = '×'; delForm.title = '删除此形态';
        fNameInput.addEventListener('input', scheduleVoiceSync);
        fVoiceInput.addEventListener('input', scheduleVoiceSync);
        fDescInput.addEventListener('input', scheduleVoiceSync);
        delForm.onclick = () => { fRow.remove(); syncVoices({ stop: false }); };
        fRow.append(fNameInput, fVoiceInput, fDescInput, delForm);
        attachVoicePicker(fVoiceInput);
        formsContainer.append(fRow);
    }

    if (typeof voiceData === 'object' && voiceData?.forms) {
        for (const [fName, fVal] of Object.entries(voiceData.forms)) {
            const fV = typeof fVal === 'string' ? fVal : (fVal?.voice || '');
            const fD = typeof fVal === 'string' ? '' : (fVal?.desc || '');
            addFormRow(fName, fV, fD);
        }
    }

    const actions = document.createElement('div'); actions.className = 'fa-form-actions';
    const addFormBtn = document.createElement('button'); addFormBtn.className = 'menu_button'; addFormBtn.textContent = '+ 添加特殊形态';
    addFormBtn.onclick = () => addFormRow();
    const exportBookBtn = document.createElement('button'); exportBookBtn.className = 'menu_button'; exportBookBtn.textContent = '导出该角色形态到世界书';
    exportBookBtn.onclick = async () => {
        const charName = nameInput.value.trim();
        if (!charName) throw new Error('请先填写角色名');
        const forms = Object.create(null);
        for (const fRow of formsContainer.querySelectorAll('.fa-form-row')) {
            const fName = fRow.querySelector('.fa-form-name')?.value.trim();
            const fVoice = fRow.querySelector('.fa-form-voice')?.value.trim();
            const fDesc = fRow.querySelector('.fa-form-desc')?.value.trim();
            if (!fName && !fVoice && !fDesc) continue;
            if (!fName) throw new Error('形态名称不能为空');
            forms[fName] = { voice: fVoice, desc: fDesc };
        }
        if (!Object.keys(forms).length) throw new Error('该角色尚未添加任何特殊形态，无需导出');
        const w = await world(), bookName = settings.book;
        if (!w.world_names.includes(bookName)) throw new Error('未找到专用世界书，请先点击【安装 / 挂载世界书】');
        const bookData = await w.loadWorldInfo(bookName);
        const entryData = buildCharacterFormWorldbookEntry(charName, forms, settings.language);
        const existingKey = Object.keys(bookData.entries || {}).find(k => bookData.entries[k].comment === entryData.comment);
        if (existingKey !== undefined) {
            bookData.entries[existingKey] = { ...bookData.entries[existingKey], ...entryData, uid: Number(existingKey) };
        } else {
            let uid = 0;
            while (Object.hasOwn(bookData.entries, uid) || Object.values(bookData.entries).some(e => e.uid === uid)) uid++;
            bookData.entries[uid] = { ...entryData, uid };
        }
        await writeBook(bookName, bookData);
        log('INFO', `已将角色【${charName}】的形态规则同步到世界书【${bookName}】（语言：${settings.language}）`);
        $('status').textContent = `已导出【${charName}】形态规则至世界书`;
    };
    actions.append(addFormBtn, exportBookBtn);

    card.append(header, formsContainer, actions);
    $('voices').append(card);
}
function renderVoices() {
    clearTimeout(voiceSyncTimer); voiceSyncTimer = 0;
    $('voices').replaceChildren();
    for (const [name, voiceData] of Object.entries(settings.voices || {})) addVoice(name, voiceData);
}
renderVoices();
click('add', () => addVoice());
click('save-voices', () => { syncVoices({ strict: true, stop: true }); log('INFO', '角色绑定已保存'); });
click('reload-voices', () => {
    renderVoices();
    log('INFO', `已从设置重新加载 ${Object.keys(settings.voices || {}).length} 个角色绑定`);
});
function renderPresetSelect(selectedName = settings.currentVoicePreset || '') {
    const select = $('preset-select'); select.replaceChildren();
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '选择预设…'; select.append(blank);
    for (const name of Object.keys(settings.voicePresets || {}).sort((a, b) => a.localeCompare(b))) {
        const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option);
    }
    select.value = Object.hasOwn(settings.voicePresets, selectedName) ? selectedName : '';
    if (select.value) $('preset-name').value = select.value;
}
$('preset-select').addEventListener('change', () => {
    const name = $('preset-select').value;
    $('preset-name').value = name || '';
});
function safeFilename(name) {
    return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/[.\s]+$/g, '') || 'preset';
}
function normalizePreset(source, fallbackName = '') {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const name = String(source.name || fallbackName || '').trim();
    if (!name) return null;
    const voices = source.voices && typeof source.voices === 'object' && !Array.isArray(source.voices) ? source.voices : {};
    return { name, defaultVoice: typeof source.defaultVoice === 'string' ? source.defaultVoice.trim() : '', voices, updatedAt: Number(source.updatedAt) || Date.now() };
}
function setVoicePreset(name, preset) {
    Object.defineProperty(settings.voicePresets, name, { value: preset, enumerable: true, writable: true, configurable: true });
}
renderPresetSelect();
click('preset-save', () => {
    const name = $('preset-name').value.trim();
    if (!name) throw new Error('请先填写预设名称');
    const voices = collectVoices(true);
    const existed = Object.hasOwn(settings.voicePresets, name);
    setVoicePreset(name, { name, defaultVoice: $('default').value.trim(), voices, updatedAt: Date.now() });
    settings.currentVoicePreset = name;
    save(); renderPresetSelect(name);
    log('INFO', `${existed ? '音声预设已覆盖' : '已保存音声预设'}【${name}】：默认音色 + ${Object.keys(voices).length} 个角色绑定`);
});
click('preset-apply', () => {
    const name = $('preset-select').value;
    const preset = settings.voicePresets[name];
    if (!preset) throw new Error('请先选择要应用的音声预设');
    stopAll();
    settings.defaultVoice = preset.defaultVoice || '';
    settings.voices = structuredClone(preset.voices || {});
    settings.currentVoicePreset = name;
    voiceWarned.clear();
    save();
    $('default').value = settings.defaultVoice;
    renderVoices(); renderPresetSelect(name); inline?.schedule();
    log('INFO', `已应用音声预设【${name}】：默认音色 + ${Object.keys(settings.voices).length} 个角色绑定`);
});
click('preset-rename', () => {
    const old = $('preset-select').value;
    if (!old) throw new Error('请先选择要重命名的音声预设');
    const name = $('preset-name').value.trim();
    if (!name) throw new Error('请填写新的预设名称');
    if (name !== old && Object.hasOwn(settings.voicePresets, name)) throw new Error(`已有同名预设：${name}`);
    const preset = settings.voicePresets[old];
    delete settings.voicePresets[old];
    preset.name = name; setVoicePreset(name, preset);
    if (settings.currentVoicePreset === old) settings.currentVoicePreset = name;
    save(); renderPresetSelect(name);
    log('INFO', `音声预设已重命名为【${name}】`);
});
click('preset-delete', async () => {
    const name = $('preset-select').value;
    if (!name) throw new Error('请先选择要删除的音声预设');
    if (!await askConfirm(`确定删除音声预设【${name}】？当前已应用的角色音色不会被删除。`)) return;
    delete settings.voicePresets[name];
    if (settings.currentVoicePreset === name) settings.currentVoicePreset = '';
    save(); renderPresetSelect('');
    $('preset-name').value = '';
    log('INFO', `已删除音声预设【${name}】`);
});
click('preset-export', () => {
    const selected = $('preset-select').value;
    const entries = settings.voicePresets || {};
    if (selected && Object.hasOwn(entries, selected)) {
        const data = { type: 'fish_dialogue_voice_preset', version: 1, ...structuredClone(entries[selected]) };
        download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), `fish-dialogue-${safeFilename(selected)}.json`);
        log('INFO', `已导出音声预设【${selected}】`);
        return;
    }
    const names = Object.keys(entries);
    if (!names.length) throw new Error('没有可导出的音声预设');
    const data = { type: 'fish_dialogue_voice_presets', version: 1, presets: structuredClone(entries) };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), 'fish-dialogue-全部音声预设.json');
    log('INFO', `已导出全部 ${names.length} 个音声预设`);
});
click('preset-import', () => $('preset-import-file').click());
$('preset-import-file').addEventListener('change', async () => {
    try {
        const input = $('preset-import-file'); const file = input.files?.[0]; input.value = '';
        if (!file) return;
        let parsed;
        try { parsed = JSON.parse(await file.text()); }
        catch (e) { throw new Error('导入文件不是有效 JSON：' + e.message); }
        const incoming = Object.create(null);
        const add = (source, fallbackName = '') => {
            const preset = normalizePreset(source, fallbackName);
            if (preset) incoming[preset.name] = preset;
        };
        if (Array.isArray(parsed)) {
            for (const item of parsed) add(item);
        } else if (parsed && typeof parsed === 'object') {
            if (parsed.presets && typeof parsed.presets === 'object') {
                for (const [key, value] of Object.entries(parsed.presets)) {
                    if (Array.isArray(value)) for (const item of value) add(item, key);
                    else add(value, key);
                }
            } else if (parsed.voicePresets && typeof parsed.voicePresets === 'object') {
                for (const [key, value] of Object.entries(parsed.voicePresets)) {
                    if (Array.isArray(value)) for (const item of value) add(item, key);
                    else add(value, key);
                }
            } else add(parsed);
        }
        const names = Object.keys(incoming);
        if (!names.length) throw new Error('导入文件中没有可识别的音声预设');
        const conflicts = names.filter(n => Object.hasOwn(settings.voicePresets, n));
        if (conflicts.length && !await askConfirm(`导入将覆盖 ${conflicts.length} 个同名预设（如 ${conflicts.slice(0, 3).join('、')}${conflicts.length > 3 ? ' 等' : ''}），是否继续？`)) return;
        for (const name of names) setVoicePreset(name, incoming[name]);
        save(); renderPresetSelect(settings.currentVoicePreset);
        log('INFO', `已导入 ${names.length} 个音声预设${conflicts.length ? `，覆盖 ${conflicts.length} 个同名预设` : ''}`);
    } catch (e) {
        log('ERROR', e.message || '导入音声预设失败');
    }
});
function generateMessage(message) {
    const id=ctx().chat.indexOf(message);
    const items=parsed(message.mes,message.name || ctx().name2,message.extra?.fish_dialogue?.language || settings.language)
        .map(s=>{
            const resolved=resolveVoice(s,settings);
            if (resolved.matched === 'default' || resolved.matched === 'none') warnUnboundVoice(s.speaker);
            return {...s,messageRef:message,uiKey:id+':'+s.block,voice:resolved.voice,model:settings.model,baseUrl:settings.baseUrl,directFetch:settings.directFetch};
        });
    if(items.some(x=>!x.voice)) throw new Error('请先填写默认音色或角色音色 ID');
    for(const item of items) generator.submit(item,{retainAudio:false});
}
click('latest',()=>generateMessage(source().message));
$('audio').addEventListener('play',()=>{queue.paused=false;});
async function world() { return worldModule ||= await import('/scripts/world-info.js'); }
async function writeBook(name, data) {
    const w = await world();
    const r = await fetch('/api/worldinfo/edit', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name, data }) });
    if (!r.ok) throw new Error(`世界书保存失败：HTTP ${r.status}`);
    w.worldInfoCache.set(name, data);
    await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_UPDATED, name, data);
    w.reloadEditor(name);
}
async function applyLanguage() {
    const w = await world(), name = settings.book;
    if (!w.world_names.includes(name)) throw new Error('请先安装世界书');
    const data = await w.loadWorldInfo(name);
    await writeBook(name, selectLanguage(data, $('language').value));
    stopAll(); settings.language = $('language').value; save();
    inline?.refresh();
    log('INFO', `世界书语言已切换为 ${settings.language}；对后续聊天生成生效`);
}
click('apply-language', applyLanguage);
click('install-book', async () => {
    const w = await world(), name = settings.book;
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('请填写合法世界书名称');
    if (!w.world_names.includes(name)) {
        const r = await fetch(new URL('./Fish-Dialogue.json', import.meta.url));
        if (!r.ok) throw new Error('扩展目录缺少 Fish-Dialogue.json');
        await writeBook(name, selectLanguage(await r.json(), $('language').value));
        await w.updateWorldInfoList();
    } else await applyLanguage();
    const options = [...document.querySelectorAll('#world_info option')];
    const option = options.find(o => o.textContent === name);
    if (!option) throw new Error('世界书已保存，但未找到挂载控件；请手动在世界书页面选择它');
    option.selected = true; window.jQuery('#world_info').trigger('change');
    settings.language = $('language').value; save();
    log('INFO', `已挂载世界书 ${name}；其他世界书保持原有选择`);
});
click('upgrade-book', async () => {
    const w = await world(), name = settings.book;
    if (!w.world_names.includes(name)) throw new Error('请先安装世界书');
    const old = await w.loadWorldInfo(name);
    const r = await fetch(new URL('./Fish-Dialogue.json', import.meta.url));
    if (!r.ok) throw new Error('新版世界书文件缺失');
    const template = await r.json();
    const upgraded = upgradeWorldbook(old, template, $('language').value);
    const backup = `${name}-backup-${Date.now()}`;
    await writeBook(backup, structuredClone(old));
    await writeBook(name, selectLanguage(upgraded, $('language').value));
    await w.updateWorldInfoList();
    stopAll(); settings.language = $('language').value; save(); inline?.refresh();
    log('INFO', `世界书已升级为中文展示 + 隐藏音声格式。旧书备份：${backup}`);
    $('status').textContent = '世界书已升级并备份；请生成一条新回复测试';
});
function download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
click('log-export', () => download(new Blob([logs.join('\n')], { type: 'text/plain;charset=utf-8' }), 'fish-dialogue-log.txt'));
click('log-clear', () => { logs.length = 0; $('logs').textContent = ''; });
async function refreshLibrary() {
    const data = await api('library'); libraryEntries = data.entries;
    $('library-path').textContent = `${data.path} · ${data.entries.length} / ${data.maxFiles} 个音频`;
    $('limit').value = data.maxFiles;
    const list = $('library-list'); list.replaceChildren();
    for (const entry of data.entries) {
        const row = document.createElement('div'); row.className = 'fa-library-item';
        const info = document.createElement('span');
        info.textContent = `${entry.speaker} · 第 ${(entry.link?.block || 0) + 1} 段 · ${entry.language} · ${new Date(entry.createdAt).toLocaleString()} · ${Math.round(entry.bytes / 1024)} KB`;
        const down = document.createElement('button'); down.textContent = '下载';
        down.onclick = async () => { try { download(await api('audio', { id: entry.id }), `${entry.id}.mp3`); } catch (e) { log('ERROR', e.message); } };
        const filename = document.createElement('small'); filename.textContent = `${entry.id}.mp3`;
        row.append(info, down, filename); list.append(row);
    }
    if (data.entries.length > 100) { const note = document.createElement('small'); note.textContent = '面板展示全部已保存音频。'; list.append(note); }
    log('INFO', `语音库：${data.entries.length} 个文件，上限 ${data.maxFiles}`);
}
click('library-refresh', refreshLibrary);
click('limit-save', async () => {
    stopAll();
    const result = await api('library/limit', { maxFiles: Number($('limit').value) });
    await refreshLibrary(); log('INFO', `保留上限已保存，清理 ${result.removed} 个最旧音频`);
});

inline = installInline({ context: ctx, settings, log, progress: key => generator.tasks.findLast(t => t.item.uiKey === key), pause: () => queue.pause(), resume: () => queue.resume(),
    current: () => ({ uiKey: queue.current?.uiKey, running: queue.running, paused: queue.paused, phase: queue.phase }),
    async play(id, ordinal) {
        const message = ctx().chat[id];
        const segment = segmentFromBlock(dialogueRecords(message.mes,{...settings,speaker:message.name || ctx().name2})[ordinal], message.extra?.fish_dialogue?.language || settings.language);
        if (!segment || isBlocked(segment.speaker, settings)) return;
        enqueue([{ ...segment, messageRef: message, uiKey: `${id}:${ordinal}` }], true);
    },
});

const c = ctx();
let generationLanguage = settings.language;
if (c.eventTypes.GENERATION_STARTED) c.eventSource.on(c.eventTypes.GENERATION_STARTED, () => { generationLanguage = settings.language; });
c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, async (id, type) => {
    const message = ctx().chat[id];
    if (!message || message.is_user || message.is_system) return;
    if (type !== 'first_message' && type !== 'quiet' && blocks(message.mes).some(b => b.paired)) {
        message.extra ||= {}; message.extra.fish_dialogue ||= {};
        message.extra.fish_dialogue.language = generationLanguage;
        try { await ctx().saveChat(); } catch { log('WARN', '消息语言元数据保存失败'); }
    }
    inline.schedule();
    if (!settings.auto || type === 'first_message' || type === 'quiet') return;
    const fingerprint = JSON.stringify([message.swipe_id, message.mes, settings.language]);
    if (seen.get(id) === fingerprint) return;
    seen.set(id, fingerprint); if (seen.size > 100) seen.delete(seen.keys().next().value);
    try { generateMessage(message); } catch (e) { log('ERROR', e.message); }
});
for (const event of ['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
    if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], () => { stopAll(); seen.clear(); inline.schedule(); });
}
for (const event of ['MORE_MESSAGES_LOADED', 'CHAT_LOADED', 'APP_READY']) if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], inline.schedule);
$('audio').addEventListener('pause', () => inline.schedule());
window.addEventListener('pagehide', () => { stopAll(); clearInterval(progressTimer); inline.disconnect(); apiKey = ''; });
log('INFO', '1.6.0 已加载；请点“升级世界书”和“添加正则”，启用 Talk-Emo 协议。');
