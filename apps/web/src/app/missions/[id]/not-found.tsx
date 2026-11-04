import { NotFoundView, workspaceDict } from "../../../components/not-found-view";

/** /missions/<id> that is no mission the reader may see (E3). */
export default async function MissionNotFound() {
  const t = await workspaceDict();
  return (
    <NotFoundView
      title={t.missions.notFound}
      body={t.missions.notFoundBody}
      actions={[
        { href: "/missions", label: t.missions.seeMissions },
        { href: "/board", label: t.notFound.toBoard },
      ]}
    />
  );
}
