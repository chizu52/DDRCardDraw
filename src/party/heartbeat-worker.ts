let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<{ intervalMs: number }>) => {
  clearInterval(timer);
  timer = setInterval(() => {
    postMessage("tick");
  }, e.data.intervalMs);
};
