const DEFAULT_TEXTS = Object.freeze({
    zh: '你好，很高兴认识你。',
    ja: 'こんにちは、よろしくお願いします。',
    en: 'Hello, nice to meet you.',
    onomatopoeia: '啊…嗯…哈哈哈…',
});

function normalizeLanguage(language) {
    return language === 'orig' ? 'zh' : (['zh', 'ja', 'en'].includes(language) ? language : 'zh');
}

export function voicePreviewText(language, settings) {
    const texts = { ...DEFAULT_TEXTS, ...(settings.voicePreviewTexts || {}) };
    const key = settings.voicePreviewMode === 'onomatopoeia' ? 'onomatopoeia' : normalizeLanguage(language);
    return texts[key] || DEFAULT_TEXTS[key];
}

export function voicePreview({ voice, language, text, previewContext = 'default' }, settings) {
    if (!voice?.trim()) throw new Error('请先填写音色 ID');
    const key = normalizeLanguage(language);
    return {
        text: String(text || voicePreviewText(language, settings)),
        speaker: '', language: key,
        voice: voice.trim(), model: settings.model,
        baseUrl: settings.baseUrl, directFetch: settings.directFetch,
        preview: true, previewContext,
    };
}

export function defaultVoicePreview(settings, text) {
    return voicePreview({
        voice: settings.defaultVoice,
        language: settings.language === 'orig' ? 'zh' : settings.language,
        text, previewContext: 'default',
    }, settings);
}
