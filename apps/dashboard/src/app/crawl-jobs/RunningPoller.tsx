'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export function RunningPoller({ hasRunning }: { hasRunning: boolean }) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!hasRunning) return;
    timerRef.current = setInterval(() => {
      router.refresh();
    }, 8_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [hasRunning, router]);

  return null;
}
