import { blocks, dialogueRecords, segmentFromBlock, isBlocked, stripExcluded } from './core.mjs';

function replacement(b, language, ordinal = b.block) {
    let value = '';
    if (segmentFromBlock(b,language) && ordinal >= 0) value += ` ⟦FAP${ordinal}⟧`;
    else if (!b.valid) value += ' ⟦FAPBAD⟧';
    return value;
}
function same(a,b) { return a.speaker === b.speaker && a.tag === b.tag && a.text === b.text && a.valid === b.valid; }
export function displayText(text, language, original = text) {
    const records = blocks(text), originalRecords = blocks(original), masked = stripExcluded(text);
    let output = String(text ?? ''), cursor = 0;
    const mapped = records.map(b => {
        const index = originalRecords.findIndex((a,i) => i >= cursor && same(a,b));
        if (index >= 0) cursor = index + 1;
        return index;
    });
    const lastEnd = records.at(-1)?.end || 0;
    const partial = masked.slice(lastEnd).search(/<talk-emo(?:\s*>|$)|<t(?:a(?:l(?:k(?:-(?:e(?:m(?:o)?)?)?)?)?)?)?$/i);
    if (partial >= 0) output = output.slice(0,lastEnd + partial) + '⟦FAPWAIT⟧';
    for (let i = records.length - 1; i >= 0; i--) {
        const b = records[i]; output = output.slice(0,b.start) + replacement(b,language,mapped[i]) + output.slice(b.end);
    }
    return output;
}
export function tokenHTML(html) {
    return html.replace(/⟦FAP(\d+|WAIT|BAD)⟧/g,(_,id) => {
        if (id === 'WAIT' || id === 'BAD') return `<span class="fa-inline-note">${id === 'WAIT' ? '语音准备中…' : '语音格式错误'}</span>`;
        return `<span class="fa-inline" data-fa-block="${id}"><button type="button" class="fa-line-play" aria-label="播放这一句">▶ 播放</button><button type="button" class="fa-line-replay" aria-label="重播这一句">↺</button><span class="fa-line-state">第 ${Number(id) + 1} 段</span></span>`;
    });
}
function fragment(text, doc) {
    const out = doc.createDocumentFragment(); let cursor = 0;
    for (const m of text.matchAll(/⟦FAP(\d+|WAIT|BAD)⟧/g)) {
        out.append(doc.createTextNode(text.slice(cursor,m.index))); cursor = m.index + m[0].length;
        const span = doc.createElement('span');
        if (m[1] === 'WAIT' || m[1] === 'BAD') {
            span.className = 'fa-inline-note'; span.textContent = m[1] === 'WAIT' ? '语音准备中…' : '语音格式错误';
        } else {
            span.className = 'fa-inline'; span.dataset.faBlock = m[1];
            for (const [name,label,aria] of [['play','▶ 播放','播放这一句'],['replay','↺','重播这一句']]) {
                const button = doc.createElement('button'); button.type='button'; button.className='fa-line-'+name; button.textContent=label; button.setAttribute('aria-label',aria); span.append(button);
            }
            const state = doc.createElement('span'); state.className='fa-line-state'; span.append(state);
        }
        out.append(span);
    }
    out.append(doc.createTextNode(text.slice(cursor))); return out;
}
const protectedSelector = 'pre,code,iframe,script,style,textarea,button,input,select,svg,canvas,.fa-inline,.fa-inline-note,.fa-line-dock,[contenteditable="true"]';
const safeTags = new Set(['P','SPAN','EM','STRONG','B','I','BR','Q','S','DEL','TALK-EMO']);

// Surgery on only the matched payload. Never call messageFormatting again, never
// assign a message container's innerHTML, and never remove/reinsert helper iframes.
export function patchTalkDom(target, records, language) {
    const doc = target.ownerDocument;
    let cursor = 0;
    for (const element of [...target.querySelectorAll('talk-emo')]) {
        if (element.parentElement?.closest(protectedSelector) || element.querySelector(protectedSelector)) continue;
        const b = blocks('<talk-emo>'+element.textContent+'</talk-emo>')[0];
        if (!b) continue;
        const index = records.findIndex((a,i) => i >= cursor && same(a,b));
        if (index < 0) continue;
        cursor = index + 1;
        // A talk-emo tag containing another app's DOM is malformed; don't destroy it.
        if ([...element.querySelectorAll('*')].some(node => !safeTags.has(node.tagName))) continue;
        element.replaceWith(fragment(replacement(records[index],language,index),doc));
    }
    const pieces = []; let text = '';
    function walk(node) {
        if (node.nodeType === 3) { pieces.push({node,start:text.length,end:text.length+node.data.length}); text += node.data; return; }
        if (node.nodeType !== 1 && node !== target) return;
        if (node !== target && (node.matches(protectedSelector) || !safeTags.has(node.tagName))) { text += '\0'; return; }
        for (const child of node.childNodes) walk(child);
    }
    walk(target);
    const matches = blocks(text).filter(b => !b.raw.includes('\0'));
    let rawCursor = 0;
    const edits = matches.map(b => {
        const i = records.findIndex((a,n) => n >= rawCursor && same(a,b));
        if (i >= 0) rawCursor = i + 1;
        return {b,index:i};
    }).filter(x => x.index >= 0);
    // Older hosts remove unknown <talk-emo> tags but retain their text content.
    // Match the exact role/language/payload, never an unlabelled quote.
    const occupied = new Set([...target.querySelectorAll('.fa-inline[data-fa-block]')].map(n => Number(n.dataset.faBlock)));
    for (const edit of edits) occupied.add(edit.index);
    let payloadCursor = 0;
    for (const [index, record] of records.entries()) {
        if (occupied.has(index) || record.protocol !== 'talk-emo' || !record.valid) continue;
        const body = record.raw.replace(/^<talk-emo\s*>/i,'').replace(/<\/talk-emo\s*>$/i,'').trim();
        const start = text.indexOf(body,payloadCursor), end = start + body.length;
        if (start < 0 || edits.some(e => start < e.b.end && end > e.b.start)) continue;
        edits.push({b:{start,end},index}); payloadCursor = end;
    }
    for (const {b,index} of edits.sort((a,b) => b.b.start-a.b.start)) {
        const start = pieces.find(p => p.start <= b.start && p.end > b.start);
        const end = pieces.find(p => p.start < b.end && p.end >= b.end);
        if (!start || !end) continue;
        const range = doc.createRange(); range.setStart(start.node,b.start-start.start); range.setEnd(end.node,b.end-end.start);
        const copied = range.cloneContents();
        if (copied.querySelector(protectedSelector) || [...copied.querySelectorAll('*')].some(n => !safeTags.has(n.tagName))) continue;
        range.deleteContents(); range.insertNode(fragment(replacement(records[index],language,index),doc));
    }
    // Host may have stripped generated button tags, leaving our plain placeholders.
    const walker = doc.createTreeWalker(target,4); const tokenNodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest(protectedSelector) && /⟦FAP(?:\d+|WAIT|BAD)⟧/.test(walker.currentNode.data)) tokenNodes.push(walker.currentNode);
    for (const node of tokenNodes) node.replaceWith(fragment(node.data,doc));
}

// If a regex or a helper owns all of the visible content, keep controls outside
// .mes_text. Never restore removed speech text or tear down the helper's DOM.
export function reconcileControls(element, target, records, language) {
    let dock = [...element.children].find(n => n.classList.contains('fa-line-dock'));
    const wanted = records.filter(b => segmentFromBlock(b,language));
    const present = new Set();
    for (const control of target.querySelectorAll('.fa-inline[data-fa-block]')) {
        const index = Number(control.dataset.faBlock);
        if (!wanted.some(b => b.block === index) || present.has(index)) { control.remove(); continue; }
        // A host sanitizer may leave the wrapper but strip its buttons.
        if (!control.querySelector('.fa-line-play') || !control.querySelector('.fa-line-replay') || !control.querySelector('.fa-line-state')) {
            control.replaceWith(fragment(`⟦FAP${index}⟧`,target.ownerDocument));
        }
        present.add(index);
    }
    const missing = wanted.filter(b => !present.has(b.block));
    if (!missing.length) { dock?.remove(); return; }
    if (!dock) {
        dock = target.ownerDocument.createElement('div'); dock.className='fa-line-dock';
        dock.setAttribute('aria-label','本条消息逐句语音'); target.after(dock);
    }
    const signature = missing.map(b => b.block).join(',');
    if (dock.dataset.signature !== signature) {
        dock.replaceChildren(fragment(missing.map(b => `⟦FAP${b.block}⟧`).join(' '),target.ownerDocument));
        dock.dataset.signature = signature;
    }
}

function updateControlsState(element, records, settings, current, progress) {
    const id = Number(element.getAttribute("mesid"));
    for (const control of element.querySelectorAll(".fa-inline[data-fa-block]")) {
        const b = records[Number(control.dataset.faBlock)]; if (!b) continue;
        const button = control.querySelector(".fa-line-play"), replay = control.querySelector(".fa-line-replay"), detail = control.querySelector(".fa-line-state");
        if (!button || !replay || !detail) continue;
        const muted = isBlocked(b.speaker, settings), state = current(), active = state.uiKey === (id + ":" + b.block);
        const p = progress(id + ":" + b.block);
        button.disabled = muted; replay.disabled = muted;
        const label = muted ? "已屏蔽" : active && state.running ? (state.phase === "generating" ? "等待音频…" : state.paused ? "▶ 继续" : "❚❚ 暂停") : "▶ 播放";
        if (button.textContent !== label) button.textContent = label;
        const suffix = p ? ({ queued: "待合成", requesting: "请求中", receiving: "接收中", saving: "保存中", ready: "已就绪", failed: "失败", canceled: "已取消" }[p.status] || "") : "";
        const value = b.speaker + " · " + (b.block + 1) + (suffix ? " · " + suffix : "");
        if (detail.textContent !== value) detail.textContent = value;
        control.classList.toggle("fa-line-active", Boolean(active && state.running));
    }
}

export function installInline({ context, settings, play, pause, resume, current, log, progress = () => null }) {
    let pending = false, disconnected = false;
    const languageFor = message => message?.extra?.fish_dialogue?.language || settings.language;
    const recordsFor = message => dialogueRecords(message?.mes,{...settings,language:languageFor(message),speaker:message?.name || context().name2});
    const formatter = context().messageFormatter;
    if (formatter?.addHook && formatter.stage?.AFTER_REGEX) {
        formatter.addHook((text,c) => c.isUser || c.isSystem || c.isReasoning ? text : displayText(text,languageFor(context().chat[c.messageId]),context().chat[c.messageId]?.mes ?? text), {stage:formatter.stage.AFTER_REGEX});
        // Leave text placeholders through Markdown and sanitization. Only the
        // post-render DOM pass creates buttons, so the host cannot strip them.
    }
    function render() {
        if (disconnected) return;
        for (const element of document.querySelectorAll("#chat .mes[mesid]")) {
            renderMessageElement(element, Number(element.getAttribute("mesid")));
        }
    }
    function renderMessageElement(element, id) {
        if (!element) return;
        const message = context().chat[id], target = element.querySelector(".mes_text");
        if (!target || !message || message.is_user || message.is_system || target.querySelector("textarea")) return;
        const records = recordsFor(message);
        patchTalkDom(target, records, languageFor(message));
        reconcileControls(target.parentElement, target, records, languageFor(message));
        updateControlsState(element, records, settings, current, progress);
    }
    function schedule() { if(pending || disconnected)return; pending=true; requestAnimationFrame(()=>{pending=false;render();}); }
    const chatSurfaceApi = window.__TAURITAVERN__?.api?.chatSurface;
    const isManaged = Boolean(chatSurfaceApi?.isManagedOwnershipRequired?.());
    if (isManaged) {
        try {
            chatSurfaceApi.registerParticipant({
                id: "fish-dialogue/inline-renderer",
                protocolVersion: chatSurfaceApi.protocolVersion || 1,
                didCommitContent({ element, mesid }) {
                    renderMessageElement(element, Number(mesid));
                },
            });
        } catch (e) {
            log?.("WARN", "ChatSurface participant 注册失败: " + e.message);
        }
    }
    const observer = new MutationObserver(mutations => {
        if(mutations.every(m => (m.target.nodeType===3 ? m.target.parentElement : m.target).closest?.('.fa-inline,.fa-inline-note')))return;
        schedule();
    });
    const chat=document.querySelector('#chat'); if(chat)observer.observe(chat,{childList:true,characterData:true,subtree:true});
    const onClick=async event=>{
        const button=event.target.closest?.('.fa-line-play,.fa-line-replay'); if(!button)return;
        const element=button.closest('.mes[mesid]'),control=button.closest('.fa-inline'); if(!element || !control)return;
        event.preventDefault();event.stopPropagation();
        const id=Number(element.getAttribute('mesid')),ordinal=Number(control.dataset.faBlock),b=recordsFor(context().chat[id])[ordinal];
        if(!b?.valid || isBlocked(b.speaker,settings))return;
        const state=current();
        try {
            if(button.classList.contains('fa-line-play') && state.uiKey===`${id}:${ordinal}` && state.running){
                if(state.phase==='generating')return;
                if(state.paused)await resume();else pause();
            }else await play(id,ordinal);
        }catch(e){log('ERROR',e.message);}schedule();
    };
    document.addEventListener('click',onClick);render();
    return {refresh:schedule,schedule,disconnect(){disconnected=true;observer?.disconnect();document.removeEventListener('click',onClick);}};
}
