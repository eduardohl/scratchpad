"use client";

import { useEffect, useState } from "react";
import { StartScreen } from "@/components/StartScreen";
import { TableView } from "@/components/TableView";
import { clearSession, loadSession } from "@/hooks/useTable";
import type { Session } from "@/hooks/useTable";

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setLoaded(true);
  }, []);

  if (!loaded) return null;

  if (!session) return <StartScreen onReady={setSession} />;

  return (
    <TableView
      key={session.startedAt}
      initial={session}
      onNewGame={() => {
        clearSession();
        setSession(null);
      }}
    />
  );
}
