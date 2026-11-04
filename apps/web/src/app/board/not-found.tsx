import { NotFoundView, workspaceDict } from "../../components/not-found-view";

/** /cards/<id> that matches no card the reader may see (E3). */
export default async function CardNotFound() {
  const t = await workspaceDict();
  return (
    <NotFoundView
      title={t.notFound.cardTitle}
      body={t.notFound.cardBody}
      actions={[{ href: "/board", label: t.notFound.toBoard }]}
    />
  );
}
