export const DEFAULTS = Object.freeze({
    baseUrl: 'https://api.fish.audio', model: 's2.1-pro-free', language: 'zh', book: 'Fish-Dialogue',
    defaultVoice: '', voices: {}, voicePresets: {}, currentVoicePreset: '',
    voiceLibrary: [], voicePreviewMode: 'greeting',
    voicePreviewTexts: { zh: '你好，很高兴认识你。', ja: 'こんにちは、よろしくお願いします。', en: 'Hello, nice to meet you.', onomatopoeia: '啊…嗯…哈哈哈…' },
    auto: false, autoVoice: false, fallback: false, blockEnabled: false, blockedNames: '', directFetch: true
});
export const ENGINES = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1', 'drama-3-preview'];

export function normalizeSpeakerName(raw) {
    return String(raw || '').normalize('NFKC').replace(/[\u00A0\u200B-\u200F\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function stripExcluded(text) {
    const mask = value => value.replace(/[^\r\n]/g, ' ');
    return String(text ?? '').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, mask)
        .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, mask)
        .replace(/<(script|style|pre|code|iframe|html)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, mask);
}

export function parseSpeakerAndForm(rawSpeaker) {
    const s = String(rawSpeaker || '').trim();
    const m = s.match(/^([^\(\)（）_#]+?)(?:\s*[\(_（#]([^\(\)（）_#]+)[\)）]?)?$/);
    if (!m) return { baseSpeaker: s, form: '' };
    return { baseSpeaker: (m[1] || '').trim(), form: (m[2] || '').trim() };
}

export function isBlocked(speaker, settings) {
    if (!settings.blockEnabled) return false;
    const names = String(settings.blockedNames || '').split(/[\n,，]/).map(x => x.trim()).filter(Boolean);
    const raw = String(speaker || '').trim();
    if (names.includes(raw)) return true;
    const canonical = normalizeSpeakerName(raw);
    if (canonical && names.some(n => normalizeSpeakerName(n) === canonical)) return true;
    const { baseSpeaker } = parseSpeakerAndForm(raw);
    if (!baseSpeaker) return false;
    const canonicalBase = normalizeSpeakerName(baseSpeaker);
    return names.some(n => normalizeSpeakerName(n) === canonicalBase);
}

export function blocks(text) {
    const source = stripExcluded(text), result = [];
    for (const m of source.matchAll(/<talk-emo\s*>([\s\S]*?)<\/talk-emo\s*>/gi)) {
        const parts = /^\s*([^|<>\r\n]+)\|(orig|zh|en|ja)\|([\s\S]*)$/.exec(m[1]);
        const body = parts?.[3]?.trim() || '', values = quotes(body);
        const valid = Boolean(parts && /^(?:"(?:\\.|[^"\\])*"|“[^”]*”)$/.test(body) && values.length === 1 && !/<\/?talk-emo\b/i.test(body));
        result.push({ start:m.index, end:m.index + m[0].length, raw:m[0], speaker:parts?.[1]?.trim() || '', tag:parts?.[2] || '',
            text:valid ? values[0] : '', valid, paired:true, protocol:'talk-emo', visible:'' });
    }
    result.sort((a,b) => a.start - b.start);
    result.forEach((b,i) => { b.block = i; });
    return result;
}

export function segmentFromBlock(b, language) {
    if (b?.protocol === 'talk-emo' || b?.protocol === 'plain') return b.valid ? { speaker:b.speaker, language:b.tag, text:b.text, block:b.block, paired:b.protocol==='talk-emo', protocol:b.protocol } : null;
    return null;
}

export function quotes(text) {
    const out = [];
    // A quote must close with its matching delimiter. Escaped ASCII quotes stay in the dialogue.
    const pattern = /"((?:\\.|[^"\\])*)"|“([^”]*)”/g;
    for (const m of text.matchAll(pattern)) {
        const value = (m[1] ?? m[2]).replace(/\\(["\\])/g, '$1').trim();
        if (value) out.push(value);
    }
    return out;
}

export function extract(text, { language = 'orig', speaker = '', fallback = true } = {}) {
    if (!['orig', 'zh', 'en', 'ja'].includes(language)) throw new Error('不支持的语言');
    const source = stripExcluded(text);
    const segments = [], warnings = [];
    const hasMarkers = /<\/?talk-emo\b/i.test(source);
    if (/\[\[\/?FA(?:\||\]\])/.test(source) && !hasMarkers) return {segments:[],warnings:['旧 FA 格式已停用，请使用 talk-emo 格式。']};
    if (/<\/?talk\s*>/i.test(source) && !hasMarkers) return {segments:[],warnings:['旧 talk 标签已停用，请升级世界书后生成新回复。']};
    const records = blocks(text);
    if (hasMarkers) {
        const starts = (source.match(/<talk-emo\s*>/gi) || []).length;
        if (starts !== records.length) warnings.push('存在未闭合或格式错误的 talk-emo 段，已跳过；不会退回全文提取。');
        for (const b of records) {
            if (!b.valid) {
                warnings.push('一个 talk-emo 段必须恰好包含一组完整双引号，已跳过。'); continue;
            }
            const segment = segmentFromBlock(b, language);
            if (segment) segments.push(segment);
        }
    } else if (fallback && language === 'orig') {
        for (const value of quotes(source)) segments.push({ speaker, language, text: value, block: segments.length, paired: false });
        if (segments.length) warnings.push('普通双引号兼容模式：所有对话使用当前消息角色，无法推断其他人物。');
    }
    if (!segments.length) warnings.push('没有可播放的目标语言对话；译文必须由聊天生成模型通过世界书输出。');
    if (segments.length > 100) throw new Error('一条消息超过 100 个对话段，请拆分消息');
    if (segments.some(x => Array.from(x.text).length > 2000)) throw new Error('单句超过 2000 字符，请让世界书将长对话拆成多个段');
    return { segments, warnings };
}

function voiceField(row, language) {
    const value = row?.[language] || row?.default;
    return typeof value === 'string' ? value.trim() : '';
}

export function findVoiceKey(raw, voices) {
    const canonical = normalizeSpeakerName(raw);
    if (!canonical) return undefined;
    return Object.keys(voices).find(key => normalizeSpeakerName(key) === canonical);
}

export function resolveVoice(segment, settings) {
    const voices = settings.voices || {};
    const rawSpeaker = String(segment.speaker || '').trim();
    const defaultVoice = settings.defaultVoice || '';

    const exactKey = findVoiceKey(rawSpeaker, voices);
    if (exactKey !== undefined) {
        const row = voices[exactKey];
        if (typeof row === 'string' && row.trim()) return { voice: row.trim(), matched: 'exact' };
        if (row && typeof row === 'object') {
            const { form } = parseSpeakerAndForm(rawSpeaker);
            if (form && row.forms && typeof row.forms === 'object') {
                const formKey = Object.keys(row.forms).find(k => normalizeSpeakerName(k) === normalizeSpeakerName(form));
                if (formKey !== undefined) {
                    const formVal = row.forms[formKey];
                    const formVoice = typeof formVal === 'string' ? formVal.trim() : (formVal?.voice || '').trim?.() || '';
                    if (formVoice) return { voice: formVoice, matched: 'form' };
                }
            }
            const voice = voiceField(row, segment.language);
            if (voice) return { voice, matched: 'exact' };
        }
    }

    const { baseSpeaker, form } = parseSpeakerAndForm(rawSpeaker);
    const baseKey = baseSpeaker && findVoiceKey(baseSpeaker, voices);
    if (baseKey !== undefined) {
        const row = voices[baseKey];
        if (typeof row === 'string' && row.trim()) return { voice: row.trim(), matched: 'base' };
        if (row && typeof row === 'object') {
            if (form && row.forms && typeof row.forms === 'object') {
                const formKey = Object.keys(row.forms).find(k => normalizeSpeakerName(k) === normalizeSpeakerName(form));
                if (formKey !== undefined) {
                    const formVal = row.forms[formKey];
                    const formVoice = typeof formVal === 'string' ? formVal.trim() : (formVal?.voice || '').trim?.() || '';
                    if (formVoice) return { voice: formVoice, matched: 'form' };
                }
            }
            const voice = voiceField(row, segment.language);
            if (voice) return { voice, matched: 'base' };
        }
    }

    return { voice: defaultVoice, matched: defaultVoice ? 'default' : 'none' };
}

export function voiceFor(segment, settings) {
    return resolveVoice(segment, settings).voice;
}

const AUTO_VOICE_LABELS = Object.freeze({ zh: '中文', ja: '日语', en: '英语' });
const AUTO_CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF\uFF66-\uFF9F]+/g;
const AUTO_WORD_RUN = /[A-Za-z0-9_]{2,}/g;
const AUTO_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'her', 'his', 'she', 'he', 'not', 'are', 'was', 'has', 'had', 'but', 'who', 'what', 'when', 'where', 'from', 'into', 'over', 'very']);

export function autoTextTokens(text) {
    const tokens = new Set();
    const value = String(text || '').normalize('NFKC').toLocaleLowerCase();
    for (const m of value.matchAll(AUTO_CJK_RUN)) {
        const run = m[0];
        if (run.length < 2) { tokens.add(run); continue; }
        for (let i = 0; i <= run.length - 2; i++) tokens.add(run.slice(i, i + 2));
    }
    for (const m of value.matchAll(AUTO_WORD_RUN)) {
        const word = m[0];
        if (!AUTO_STOPWORDS.has(word)) tokens.add(word);
    }
    return tokens;
}

export function autoMatchScore(profile, entry, language = 'zh') {
    const roleText = `${profile?.text || ''} ${profile?.name || ''}`;
    const roleTokens = autoTextTokens(roleText);
    const entryText = [entry?.name, entry?.sub, entry?.desc, AUTO_VOICE_LABELS[entry?.category] || ''].filter(Boolean).join(' ');
    const entryTokens = autoTextTokens(entryText);
    let score = 0;
    for (const token of roleTokens) {
        if (!entryTokens.has(token)) continue;
        score += /^[A-Za-z0-9_]{4,}$/.test(token) ? 3 : 2;
    }
    const roleName = normalizeSpeakerName(profile?.name || '');
    const entryName = normalizeSpeakerName(entry?.name || '');
    if (roleName && entryName) {
        if (roleName === entryName) score += 10;
        else if (entryName.length >= 2 && (roleName.includes(entryName) || entryName.includes(roleName))) score += 5;
    }
    const form = String(profile?.form || '').trim();
    if (form.length >= 2) {
        for (const token of autoTextTokens(form)) {
            if (entryTokens.has(token) || entryText.includes(form)) { score += 3; break; }
        }
    }
    const desc = String(entry?.desc || '').trim();
    const sub = String(entry?.sub || '').trim();
    const name = String(entry?.name || '').trim();
    if (desc.length >= 2 && roleText.includes(desc)) score += 8;
    if (sub.length >= 2 && roleText.includes(sub)) score += 6;
    if (name.length >= 2 && roleText.includes(name)) score += 4;
    if (desc) {
        for (const m of desc.matchAll(AUTO_CJK_RUN)) {
            const run = m[0];
            if (run.length >= 2 && roleText.includes(run)) score += Math.min(4, run.length);
        }
    }
    if (entry?.category === language || AUTO_VOICE_LABELS[entry?.category] === language) score += 2;
    return score;
}

export function pickAutoVoice(profile, library, language = 'zh', minScore = 6) {
    let best = null;
    for (const entry of library || []) {
        if (!String(entry?.id || '').trim()) continue;
        const score = autoMatchScore(profile, entry, language);
        if (!best || score > best.score) best = { entry, score };
    }
    return best && best.score >= minScore ? best : null;
}

export function dialogueRecords(text, settings) {
    const records=blocks(text);
    if(records.length || !settings.fallback) return records;
    return extract(text,settings).segments.map(s=>({...s,tag:s.language,valid:true,protocol:'plain'}));
}

export function selectLanguage(book, language) {
    if (!['orig', 'zh', 'en', 'ja'].includes(language)) throw new Error('不支持的语言');
    const data = structuredClone(book);
    const entries = Object.values(data?.entries || {});
    if (entries.some(e => Object.values(BOOK_LANGUAGES).includes(e.comment))) {
        for (const name of Object.values(BOOK_LANGUAGES)) {
            if (entries.filter(e => e.comment === name).length !== 1) throw new Error(`世界书缺少或重复条目：${name}`);
        }
        for (const e of entries) if (Object.values(BOOK_LANGUAGES).includes(e.comment)) e.disable = e.comment !== BOOK_LANGUAGES[language];
        return data;
    }
    for (const name of ['FA_FORMAT', 'FA_LANG_orig', 'FA_LANG_zh', 'FA_LANG_en', 'FA_LANG_ja']) {
        if (entries.filter(e => e.comment === name).length !== 1) throw new Error(`世界书缺少或重复条目：${name}`);
    }
    for (const e of entries) {
        if (e.comment === 'FA_FORMAT') e.disable = false;
        if (/^FA_LANG_(orig|zh|en|ja)$/.test(e.comment)) e.disable = e.comment !== `FA_LANG_${language}`;
    }
    return data;
}

export const BOOK_LANGUAGES = Object.freeze({ zh: 'FA_FORMAT · 中文', ja: 'FA_FORMAT · 日语', en: 'FA_FORMAT · 英语' });

export function upgradeWorldbook(old, template, language) {
    selectLanguage(template, language);
    if (!old?.entries || typeof old.entries !== 'object') throw new Error('旧世界书格式错误');
    const data = structuredClone(old);
    const managed = name => Object.values(BOOK_LANGUAGES).includes(name) || /^(FA_FORMAT|FA_LANG_(orig|zh|en|ja))$/.test(name);
    for (const [key, entry] of Object.entries(data.entries)) if (managed(entry.comment)) delete data.entries[key];
    for (const entry of Object.values(template.entries)) {
        let uid = 0;
        while (Object.hasOwn(data.entries, uid) || Object.values(data.entries).some(e => e.uid === uid)) uid++;
        data.entries[uid] = { ...structuredClone(entry), uid };
    }
    return selectLanguage(data, language);
}

export function buildCharacterFormWorldbookEntry(characterName, forms, language = 'zh') {
    const langTag = (language === 'en' || language === 'ja') ? language : 'zh';
    const formLines = [];
    for (const [formName, formData] of Object.entries(forms || {})) {
        const desc = typeof formData === 'string' ? '' : (formData?.desc || '');
        const condition = desc ? `（触发情境：${desc}）` : '';
        formLines.push(`- ${characterName}(${formName})${condition}：输出 <Talk-Emo>${characterName}(${formName})|${langTag}|"..."</Talk-Emo>`);
    }

    const defaultExample = `- ${characterName}（常规/日常形态）：输出 <Talk-Emo>${characterName}|${langTag}|"..."</Talk-Emo>`;

    const content = `<talk_emo_persona_rules>
# 角色特殊形态配音标签规则：${characterName}

当该角色在剧情中发生状态变化、变身、心境剧烈转变或处于特定形态时，请在 <Talk-Emo> 的角色名部分附带形态标识：

${defaultExample}
${formLines.join('\n')}

注意：
1. 仅在符合上述特殊形态情境时使用带括号的形态名称。
2. 常规或未注明形态的日常状态下，保持使用无括号的原始角色名 \`${characterName}\`。
3. 括号必须紧随角色名后，格式如 \`${characterName}(形态名)\`，语言字段依然为 \`|${langTag}|\`。
</talk_emo_persona_rules>`;

    return {
        key: [characterName, `${characterName}(`, `${characterName}（`],
        keysecondary: [],
        comment: `Fish-Dialogue · ${characterName}形态`,
        content: content.trim(),
        constant: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 8885,
        position: 4,
        depth: 1,
        role: 2,
        disable: false,
        probability: 100,
        useProbability: true,
        excludeRecursion: true,
        preventRecursion: true,
        ignoreBudget: false,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        vectorized: false,
        delayUntilRecursion: false,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        displayIndex: 0,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        outletName: '',
        useGroupScoring: null,
        automationId: '',
        triggers: [],
        characterFilter: { isExclude: false, names: [], tags: [] }
    };
}
