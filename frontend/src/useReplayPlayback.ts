import { useEffect, useState } from "react";

export function useReplayPlayback(
  frames: readonly unknown[] | undefined,
  ready: boolean,
  delay: number,
) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing || !ready || !frames) return;
    if (index === frames.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex(index + 1), delay);
    return () => window.clearTimeout(timer);
  }, [playing, ready, frames, index, delay]);

  useEffect(() => {
    function pauseWhenHidden() {
      if (document.hidden) setPlaying(false);
    }
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  return { index, setIndex, playing, setPlaying };
}
