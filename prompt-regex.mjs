// Only AI chat history at prompt construction, never the stored message or worldbook.
export const PROMPT_REGEX = Object.freeze({
    id: '825e6192-4033-4d69-82e2-edc8acb96781',
    scriptName: 'Fish Dialogue：Talk-Emo 不发送给 LLM',
    findRegex: '/<Talk-Emo\\s*>[\\s\\S]*?(?:<\\/Talk-Emo\\s*>|$)/gi',
    replaceString: '', trimStrings: [], placement: [2],
    disabled: false, markdownOnly: false, promptOnly: true,
    runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null,
});

export function upsertPromptRegex(scripts) {
    if (!Array.isArray(scripts)) throw new Error('酒馆正则设置不是有效列表，未修改原设置');
    const next = scripts.filter(s => s.id !== PROMPT_REGEX.id);
    next.push(structuredClone(PROMPT_REGEX));
    return next;
}

export async function installPromptRegex(context, loadEngine = () => import('/scripts/extensions/regex/engine.js')) {
    if (context.extensionSettings.disabledExtensions?.includes('regex')) {
        throw new Error('酒馆的正则扩展已禁用，请先启用，再点击添加正则');
    }
    let engine;
    try { engine = await loadEngine(); }
    catch { throw new Error('无法加载酒馆正则接口；可在正则扩展手动导入安装包中的 Talk-Emo-prompt-regex.json'); }
    if (!engine.getScriptsByType || !engine.saveScriptsByType || engine.SCRIPT_TYPES?.GLOBAL === undefined) {
        throw new Error('酒馆正则接口版本不支持自动添加，请手动导入 Talk-Emo-prompt-regex.json');
    }
    const type = engine.SCRIPT_TYPES.GLOBAL;
    await engine.saveScriptsByType(upsertPromptRegex(engine.getScriptsByType(type)), type);
}
