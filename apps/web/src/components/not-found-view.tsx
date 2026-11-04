import { connection } from "next/server";
import { db } from "../lib/db";
import { dict, type Dict } from "../lib/i18n";

/** The workspace's language, or English when there is no database to ask. */
export async function workspaceDict(): Promise<Dict> {
  // Read per request: prerendered at build time, the page would keep the
  // language of a build that had no database to ask.
  await connection();
  try {
    const ws = await db().query.workspace.findFirst({ columns: { language: true } });
    return dict(ws?.language);
  } catch {
    return dict("en");
  }
}

/**
 * What a signed-in page shows when the thing its address names is not there
 * for the reader (navigation plan E3, M10): a card or a mission that does not
 * exist and one the reader may not see read the same, with the way back.
 */
export function NotFoundView({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions: { href: string; label: string }[];
}) {
  return (
    <div className="nb nebula-surface">
      <div className="nf-page">
        <section className="nf-box" aria-labelledby="nf-title">
          <h1 id="nf-title">{title}</h1>
          <p>{body}</p>
          <div className="nf-acts">
            {actions.map((action, index) => (
              <a
                key={action.href}
                className={index === 0 ? "nf-act primary" : "nf-act"}
                href={action.href}
              >
                {action.label}
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
