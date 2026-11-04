"use client";

import type { TaskPriority, TaskType } from "@agent-board/db";
import { Icon } from "../../components/icon";
import {
  NO_MISSION,
  activeFilterChips,
  periodIsDefault,
  type BoardFilter,
  type FilterChipKey,
} from "../../lib/board-filter";
import type { Dict } from "../../lib/i18n";

/**
 * The line under the filters (navigation plan E4): one removable chip per
 * narrowed dimension and one for the search words, then the two ways back,
 * kept apart on purpose. "Clear filters" drops the chips and keeps the scope
 * and the period; "Back to 7 days" puts the remembered period back to the
 * default and touches nothing else. Nothing is drawn on a board that is not
 * narrowed and sits on the default period.
 */
export function FilterChips({
  filter,
  missions,
  query,
  shown,
  searching,
  searchLimited,
  onRemove,
  onClearSearch,
  onClear,
  onResetPeriod,
  t,
}: {
  filter: BoardFilter;
  missions: { id: string; title: string }[];
  query: string;
  /** How many cards the board shows now. */
  shown: number;
  searching: boolean;
  searchLimited: boolean;
  onRemove: (key: FilterChipKey) => void;
  onClearSearch: () => void;
  onClear: () => void;
  onResetPeriod: () => void;
  t: Dict;
}) {
  const chips = activeFilterChips(filter, {
    mission: (id) => missions.find((item) => item.id === id)?.title ?? null,
  });
  const words = query.trim();
  const defaultPeriod = periodIsDefault(filter);
  const narrowed = chips.length > 0 || words.length > 0;
  if (!narrowed && defaultPeriod) return null;

  const typeNames: Record<TaskType, string> = {
    bug: t.board.typeBug,
    feature: t.board.typeFeature,
    rfc: t.board.typeRfc,
  };
  const priorityNames: Record<TaskPriority, string> = {
    urgente: t.board.priorityUrgent,
    alta: t.board.priorityHigh,
    media: t.board.priorityMedium,
    baixa: t.board.priorityLow,
  };
  const labels: Record<FilterChipKey, string> = {
    mission: t.filterLine.chipMission,
    types: t.board.typeFilter,
    priorities: t.board.priorityFilter,
    release: t.board.releaseFilter,
  };
  const valueText = (key: FilterChipKey, value: string | null): string => {
    if (key === "types") return typeNames[value as TaskType] ?? String(value);
    if (key === "priorities") return priorityNames[value as TaskPriority] ?? String(value);
    if (key === "release") return value ?? t.board.noRelease;
    return value === NO_MISSION ? t.board.noMission : String(value);
  };

  const chip = (key: string, label: string, text: string, onX: () => void) => (
    <span className="fc-chip" key={key}>
      <span className="fc-k">{label}:</span>
      <span className="fc-v" title={text}>
        {text}
      </span>
      <button
        type="button"
        className="fc-x"
        aria-label={t.filterLine.removeChip(label)}
        title={t.filterLine.removeChip(label)}
        onClick={onX}
      >
        <Icon name="close" label={null} size={12} />
      </button>
    </span>
  );

  return (
    <div className="filter-chips">
      {chips.map((item) =>
        chip(
          item.key,
          labels[item.key],
          item.values.map((value) => valueText(item.key, value)).join(", "),
          () => onRemove(item.key),
        ),
      )}
      {words ? chip("search", t.filterLine.chipSearch, words, onClearSearch) : null}
      {narrowed ? (
        <button type="button" className="fc-btn clear-board-filters" onClick={onClear}>
          {t.board.clearFilters}
        </button>
      ) : null}
      {!defaultPeriod ? (
        <button type="button" className="fc-btn fc-period" onClick={onResetPeriod}>
          {t.filterLine.backTo7}
        </button>
      ) : null}
      <span className="fc-count">
        {searching ? t.board.searchingOlder : t.board.cardsShown(shown)}
        {searchLimited && !searching ? <> · {t.board.searchLimited}</> : null}
        {narrowed ? <> · {t.filterLine.clearKeeps}</> : null}
      </span>
    </div>
  );
}
