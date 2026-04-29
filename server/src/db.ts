import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

/** Single shared family session — no room scoping. */
export type TurnRecord = {
  turnId: string;
  speakerId: string;
  sourceLanguage: "en" | "ja";
  sourceText: string;
  targetLanguage: "en" | "ja";
  targetText: string;
};

export type CorrectionRecord = {
  userId: string;
  wrongText: string;
  rightText: string;
  context: string;
};

const SCHEMA_VERSION = 2;

export class AppDb {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const fullPath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new Database(fullPath);
    this.migrate();
  }

  private migrate() {
    const versionRaw = this.db.pragma("user_version", { simple: true });
    const userVersion = typeof versionRaw === "number" ? versionRaw : Number(versionRaw);

    if (userVersion < SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS glossary;
        DROP TABLE IF EXISTS turns;
        DROP TABLE IF EXISTS corrections;
      `);
      this.db.exec(`
        CREATE TABLE glossary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          term TEXT NOT NULL,
          translation TEXT NOT NULL,
          notes TEXT DEFAULT '',
          UNIQUE(user_id, term)
        );

        CREATE TABLE turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          turn_id TEXT NOT NULL,
          speaker_id TEXT NOT NULL,
          source_language TEXT NOT NULL,
          source_text TEXT NOT NULL,
          target_language TEXT NOT NULL,
          target_text TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE corrections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          wrong_text TEXT NOT NULL,
          right_text TEXT NOT NULL,
          context TEXT DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  upsertGlossary(userId: string, term: string, translation: string, notes: string) {
    this.db
      .prepare(
        `INSERT INTO glossary(user_id, term, translation, notes)
         VALUES (@userId, @term, @translation, @notes)
         ON CONFLICT(user_id, term)
         DO UPDATE SET translation = excluded.translation, notes = excluded.notes`
      )
      .run({ userId, term, translation, notes });
  }

  listGlossary(): Array<{ userId: string; term: string; translation: string; notes: string }> {
    return this.db
      .prepare(
        `SELECT user_id AS userId, term, translation, notes
         FROM glossary
         ORDER BY user_id, term`
      )
      .all() as Array<{ userId: string; term: string; translation: string; notes: string }>;
  }

  insertTurn(turn: TurnRecord) {
    this.db
      .prepare(
        `INSERT INTO turns(
          turn_id, speaker_id, source_language, source_text, target_language, target_text
        ) VALUES(
          @turnId, @speakerId, @sourceLanguage, @sourceText, @targetLanguage, @targetText
        )`
      )
      .run(turn);
  }

  latestTurns(limit = 3): Array<{ sourceText: string; targetText: string }> {
    return this.db
      .prepare(
        `SELECT source_text AS sourceText, target_text AS targetText
         FROM turns
         ORDER BY id DESC
         LIMIT @limit`
      )
      .all({ limit }) as Array<{ sourceText: string; targetText: string }>;
  }

  insertCorrection(correction: CorrectionRecord) {
    this.db
      .prepare(
        `INSERT INTO corrections(user_id, wrong_text, right_text, context)
         VALUES(@userId, @wrongText, @rightText, @context)`
      )
      .run(correction);
  }

  latestCorrections(limit = 20): Array<{ wrongText: string; rightText: string; context: string }> {
    return this.db
      .prepare(
        `SELECT wrong_text AS wrongText, right_text AS rightText, context
         FROM corrections
         ORDER BY id DESC
         LIMIT @limit`
      )
      .all({ limit }) as Array<{ wrongText: string; rightText: string; context: string }>;
  }

  close() {
    this.db.close();
  }
}
