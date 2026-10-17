"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-renders the server page on an interval, so new tickets show up without a reload.
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
