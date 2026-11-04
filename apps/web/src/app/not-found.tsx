import { Wordmark } from "../components/wordmark";
import { workspaceDict } from "../components/not-found-view";

/**
 * An address that leads nowhere (navigation plan E3, M10), in the language of
 * the workspace, with the wordmark and the way back to the board. Signed out,
 * the board sends the reader on to the login.
 */
export default async function NotFound() {
  const t = await workspaceDict();
  return (
    <>
      <p className="brand">
        <Wordmark label={t.board.homeLink} size={18} />
      </p>
      <h1>{t.notFound.title}</h1>
      <p className="sub">{t.notFound.body}</p>
      <a className="primary" href="/board">
        {t.notFound.toBoard}
      </a>
    </>
  );
}
