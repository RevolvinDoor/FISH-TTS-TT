// A serial producer independent of the audio player. A paused player does not hold
// up the next API request, except when bounded transient audio memory is full.
export class SynthesisQueue {
    constructor({ synthesize, changed = () => {}, maxBufferedBytes = 32 * 1024 * 1024 }) {
        Object.assign(this, { synthesize, changed, maxBufferedBytes });
        this.tasks = []; this.pending = []; this.bufferedBytes = 0; this.epoch = 0; this.running = false;
    }
    key(item) { return JSON.stringify([item.uiKey, item.text, item.speaker, item.language, item.voice, item.model, item.baseUrl, item.messageRef?.mes]); }
    submit(item, { retainAudio = true } = {}) {
        const key = this.key(item);
        const existing = this.tasks.find(t => t.key === key && (['queued','requesting','receiving','saving'].includes(t.status) || t.blob));
        if (existing) { existing.retainAudio ||= retainAudio; return existing; }
        if (this.pending.length >= 100) throw new Error('合成等待队列已满（100 句）');
        const task = { key, item, retainAudio, status:'queued', receivedBytes:0, totalBytes:null, queuedAt:Date.now(), id: item.jobId, blob:null };
        task.done = new Promise(resolve => { task.resolve = resolve; });
        this.tasks.push(task); this.pending.push(task);
        // Keep only a bounded terminal history; pending promises and buffered audio remain alive.
        if (this.tasks.length > 300) this.tasks = this.tasks.filter(t => !['ready','failed','canceled'].includes(t.status) || t.blob || this.tasks.indexOf(t) >= this.tasks.length - 200);
        this.changed(this); void this.run(); return task;
    }
    cancelTask(task) {
        if (!task || ['failed','canceled'].includes(task.status)) return;
        task.controller?.abort(); task.status = 'canceled'; task.error = '已取消'; task.finishedAt = Date.now();
        if (task.blob) { this.bufferedBytes -= task.blob.size; task.blob = null; }
        task.resolve(); this.wake?.(); this.changed(this);
    }
    cancel() {
        this.epoch++; this.running = false;
        this.pending = [];
        for (const task of this.tasks) if (task.status !== 'ready' || task.blob) this.cancelTask(task);
        this.wake?.(); this.changed(this);
    }
    async take(task, signal) {
        if (signal.aborted) throw new DOMException('Aborted','AbortError');
        task.retainAudio = true;
        let abort;
        const aborted = new Promise((_,reject) => { abort = () => { this.cancelTask(task); reject(new DOMException('Aborted','AbortError')); }; signal.addEventListener('abort',abort,{once:true}); });
        try { await Promise.race([task.done, aborted]); }
        finally { signal.removeEventListener('abort',abort); }
        if (signal.aborted) throw new DOMException('Aborted','AbortError');
        if (task.status !== 'ready') throw new Error(task.error || '合成未完成');
        const blob = task.blob;
        if (!blob) throw new Error('音频已播放或释放，请重新点击播放');
        task.blob = null; this.bufferedBytes -= blob.size; this.wake?.(); this.changed(this);
        return blob;
    }
    async run() {
        if (this.running) return;
        this.running = true; const epoch = this.epoch;
        while (this.pending.length && epoch === this.epoch) {
            if (this.bufferedBytes >= this.maxBufferedBytes) {
                this.memoryPaused = true; this.changed(this);
                await new Promise(resolve => { this.wake = resolve; });
                this.wake = null; this.memoryPaused = false;
                if (epoch !== this.epoch) break;
            }
            const task = this.pending.shift();
            if (task.status === 'canceled') continue;
            task.controller = new AbortController(); task.startedAt = Date.now(); task.status = 'requesting'; this.changed(this);
            try {
                const blob = await this.synthesize(task.item, task.controller.signal, patch => {
                    if (epoch !== this.epoch || task.status === 'canceled') return;
                    // Never let a late poll downgrade the local terminal state.
                    Object.assign(task, patch); this.changed(this);
                });
                if (epoch !== this.epoch || task.controller.signal.aborted) { this.cancelTask(task); continue; }
                if (task.retainAudio) { task.blob = blob; this.bufferedBytes += blob.size; }
                task.status = 'ready'; task.receivedBytes = blob.size; task.finishedAt = Date.now(); task.resolve();
            } catch (e) {
                if (epoch !== this.epoch || task.controller.signal.aborted) { this.cancelTask(task); continue; }
                task.status = 'failed'; task.error = e.message; task.finishedAt = Date.now(); task.resolve();
                // Stop following requests on authentication, quota or network errors; no blind retries.
                for (const pending of this.pending) this.cancelTask(pending);
                this.pending = [];
            }
            this.changed(this);
        }
        if (epoch === this.epoch) { this.running = false; this.changed(this); }
    }
}
