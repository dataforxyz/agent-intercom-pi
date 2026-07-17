import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "../types.ts";
import { sanitizeDisplayText, searchableSessionText, sessionOriginLabel, shortestUniqueIdPrefixes } from "./session-identity.ts";

function middleTruncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) {
    return text;
  }
  if (maxWidth <= 3) {
    return truncateToWidth(text, maxWidth, "");
  }

  const chars = [...text];
  const targetSideWidth = Math.max(1, Math.floor((maxWidth - 1) / 2));

  let left = "";
  for (const char of chars) {
    if (visibleWidth(left + char) > targetSideWidth) break;
    left += char;
  }

  let right = "";
  for (const char of chars.slice().reverse()) {
    if (visibleWidth(char + right) > targetSideWidth) break;
    right = char + right;
  }

  return truncateToWidth(`${left}…${right}`, maxWidth, "");
}

function sessionTitle(
  session: SessionInfo,
  idPrefix: string,
  options?: { self?: boolean; sameCwd?: boolean },
): string {
  const name = sanitizeDisplayText(session.name, "Unnamed session");
  const tags = [options?.self ? "self" : undefined, options?.sameCwd ? "same cwd" : undefined, sessionOriginLabel(session)]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `${name} (${sanitizeDisplayText(idPrefix, "unknown")})${suffix}`;
}

export class SessionListOverlay implements Component {
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private currentSession: SessionInfo;
  private done: (result: SessionInfo | undefined) => void;
  private sessions: SessionInfo[];
  private selectedIndex = 0;
  private maxVisible = 8;
  private query = "";
  private idPrefixes: Map<string, string>;

  constructor(
    theme: Theme,
    keybindings: KeybindingsManager,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.currentSession = currentSession;
    this.sessions = sessions;
    this.done = done;
    this.idPrefixes = shortestUniqueIdPrefixes([currentSession.id, ...sessions.map(session => session.id)]);
  }

  private get filteredSessions(): SessionInfo[] {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return this.sessions;
    return this.sessions.filter(session => searchableSessionText(session).includes(query));
  }

  private onSessionSelect(sessionId: string, sessions: SessionInfo[]): void {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    this.done(session);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    const sessions = this.filteredSessions;

    if (this.keybindings.matches(data, "tui.select.up")) {
      if (sessions.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? sessions.length - 1 : this.selectedIndex - 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      if (sessions.length === 0) return;
      this.selectedIndex = this.selectedIndex === sessions.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const session = sessions[this.selectedIndex];
      if (session) {
        this.onSessionSelect(session.id, sessions);
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.query = [...this.query].slice(0, -1).join("");
      this.selectedIndex = 0;
      return;
    }

    if (!data.startsWith("\x1b")) {
      const printable = [...data].filter(character => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127 && !(code >= 128 && code <= 159);
      }).join("");
      if (printable) {
        this.query += printable;
        this.selectedIndex = 0;
      }
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, Math.min(width, 88));
    if (innerWidth === 1) {
      return [this.theme.fg("accent", "│")];
    }

    const contentWidth = Math.max(0, innerWidth - 2);
    const footer = `Type: Filter • ${this.keybindings.getKeys("tui.select.confirm").join("/")}: Message • ${this.keybindings.getKeys("tui.select.cancel").join("/")}: Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    const sessions = this.filteredSessions;
    if (this.selectedIndex >= sessions.length) this.selectedIndex = Math.max(0, sessions.length - 1);
    const currentIdPrefix = this.idPrefixes.get(this.currentSession.id) ?? this.currentSession.id;
    const currentCwd = sanitizeDisplayText(this.currentSession.cwd, "Unknown path");
    const currentModel = sanitizeDisplayText(this.currentSession.model, "Unknown model");
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(" Current Session")));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());
    lines.push(row(`  ${this.theme.fg("dim", sessionTitle(this.currentSession, currentIdPrefix, { self: true }))}`));
    lines.push(row(`  ${this.theme.fg("dim", `${middleTruncate(currentCwd, Math.max(8, contentWidth - 4))} • ${currentModel}`)}`));
    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.bold(" Other Sessions")));
    lines.push(row(this.theme.fg("dim", ` Search: ${sanitizeDisplayText(this.query)}█`)));
    lines.push(row());

    if (sessions.length === 0) {
      lines.push(row(this.theme.fg("dim", this.sessions.length === 0
        ? " No other intercom-connected sessions"
        : ` No sessions match “${sanitizeDisplayText(this.query)}”`)));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), sessions.length - this.maxVisible),
      );
      const endIndex = Math.min(startIndex + this.maxVisible, sessions.length);

      for (let index = startIndex; index < endIndex; index += 1) {
        const session = sessions[index];
        const isSelected = index === this.selectedIndex;
        const sameCwd = session.cwd === this.currentSession.cwd;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const idPrefix = this.idPrefixes.get(session.id) ?? session.id;
        const title = sessionTitle(session, idPrefix, { sameCwd });
        const cwd = sanitizeDisplayText(session.cwd, "Unknown path");
        const model = sanitizeDisplayText(session.model, "Unknown model");
        const pathText = `${middleTruncate(cwd, Math.max(8, contentWidth - 4))} • ${model}`;

        lines.push(row(`${prefix}${isSelected ? this.theme.fg("accent", title) : title}`));
        lines.push(row(`  ${this.theme.fg("dim", pathText)}`));
        if (index < endIndex - 1) {
          lines.push(row());
        }
      }

      if (startIndex > 0 || endIndex < sessions.length) {
        lines.push(row());
        lines.push(row(this.theme.fg("dim", ` ${this.selectedIndex + 1}/${sessions.length}`)));
      }
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));

    return lines;
  }
}
