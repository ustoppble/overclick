"use client";

import { useEffect, useState } from "react";
import { Wordmark } from "../components/wordmark";
import { dict } from "../lib/i18n";

/**
 * When a page fails (navigation plan E3, M10): the same words and way back as
 * the page that finds nothing. The workspace's language is the server's to
 * read, and the server is what failed, so the browser's language picks it.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  const missingDb = /DATABASE_URL/.test(error.message);
  const [canReload, setCanReload] = useState(false);
  const [lang, setLang] = useState("en");

  useEffect(() => {
    setCanReload(true);
    if (navigator.language.toLowerCase().startsWith("pt")) setLang("pt-BR");
  }, []);

  const t = dict(lang);

  const handleRetry = () => {
    if (reset) reset();
    else if (typeof window !== "undefined") window.location.reload();
  };

  return (
    <div className="shell">
      <p className="brand">
        <Wordmark label={t.board.homeLink} size={18} />
      </p>
      <h1>{missingDb ? t.errorPage.missingDbTitle : t.errorPage.title}</h1>
      <p className="sub">{missingDb ? t.errorPage.missingDbBody : t.errorPage.body}</p>
      <button
        type="button"
        className="primary"
        onClick={handleRetry}
        disabled={!canReload}
      >
        {t.errorPage.retry}
      </button>
      {error.digest ? (
        <p className="meta" style={{ marginTop: 24 }}>
          {t.errorPage.digest} <span className="error">{error.digest}</span>
        </p>
      ) : null}
    </div>
  );
}
