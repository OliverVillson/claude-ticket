import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { detectColorLevel, type ColorLevel } from '../../ui/theme.ts';
import { renderDog, renderTrack, type DogSize } from './render.ts';
import { sharedTicker, type Ticker } from './ticker.ts';

export interface DogProps {
  /** true while agents are working: the dog runs. false: it sleeps (and no timer runs unless `sleepAnimation`). */
  running: boolean;
  /** 'mini' is 2 rows by 12 columns (14 asleep) for narrow layouts */
  size?: DogSize;
  /** 0..1: when given the dog runs along a track `trackWidth` cells wide as a progress marker */
  progress?: number;
  trackWidth?: number;
  level?: ColorLevel;
  ticker?: Ticker;
}

/**
 * `<Dog running={n > 0} />`. Each row is one Ink <Text> holding an ANSI string (see tui/style.ts
 * for why). Only this component re-renders on a tick, and only while running.
 */
export function Dog({ running, size = 'full', progress, trackWidth, level = detectColorLevel(process.env, true), ticker = sharedTicker }: DogProps) {
  const [tick, setTick] = useState(ticker.tick);
  useEffect(() => {
    if (!running) return;
    return ticker.subscribe(setTick);
  }, [running, ticker]);
  const lines =
    running && progress !== undefined && trackWidth
      ? renderTrack(tick, trackWidth, progress, { size, level })
      : renderDog(running ? tick : 0, { mode: running ? 'run' : 'sleep', size, level });
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => <Text key={i}>{l}</Text>)}
    </Box>
  );
}
