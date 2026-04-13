// ============================================================
// src/utils/helpers.ts
// ============================================================

import { Book } from "../models";

export type SortKey = "dateAdded" | "title" | "author" | "series";

export function sortBooks(books: Book[], key: SortKey): Book[] {
  return [...books].sort((a, b) => {
    switch (key) {
      case "title":
        return a.title.localeCompare(b.title);
      case "author":
        return a.author.localeCompare(b.author);
      case "series":
        return (a.series ?? "").localeCompare(b.series ?? "");
      case "dateAdded":
      default:
        return b.dateAdded - a.dateAdded;
    }
  });
}

export function formatProgress(progress: number): string {
  return `${Math.round(progress)}%`;
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
