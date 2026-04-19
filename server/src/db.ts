import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type TurnRecord = {
  roomId: string;
  turnId: string;
  speakerId: string;
  sourceLanguage: "en" | "ja";
  sourceText: string;
  targetLanguage: "en" | "ja";
  targetText: string;
};

export type CorrectionRecord = {
  roomId: string;
  userId: string;
  wrongText: string;
  rightText: string;
  context: string;
};

export class AppDb {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const fullPath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new Database(fullPath);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS glossary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        term TEXT NOT NULL,
        translation TEXT NOT NULL,
        notes TEXT DEFAULT '',
        UNIQUE(room_id, user_id, term)
      );

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        source_language TEXT NOT NULL,
        source_text TEXT NOT NULL,
        target_language TEXT NOT NULL,
        target_text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        wrong_text TEXT NOT NULL,
        right_text TEXT NOT NULL,
        context TEXT DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
    `);
  }

  upsertGlossary(roomId: string, userId: string, term: string, translation: string, notes: string) {
    this.db
      .prepare(
        `INSERT INTO glossary(room_id, user_id, term, translation, notes)
         VALUES (@roomId, @userId, @term, @translation, @notes)
         ON CONFLICT(room_id, user_id, term)
         DO UPDATE SET translation = excluded.translation, notes = excluded.notes`
      )
      .run({ roomId, userId, term, translation, notes });
  }

  listGlossary(roomId: string): Array<{ userId: string; term: string; translation: string; notes: string }> {
    return this.db
      .prepare(
        `SELECT user_id AS userId, term, translation, notes
         FROM glossary
         WHERE room_id = @roomId
         ORDER BY user_id, term`
      )
      .all({ roomId }) as Array<{ userId: string; term: string; translation: string; notes: string }>;
  }

  insertTurn(turn: TurnRecord) {
    this.db
      .prepare(
        `INSERT INTO turns(
          room_id, turn_id, speaker_id, source_language, source_text, target_language, target_text
        ) VALUES(
          @roomId, @turnId, @speakerId, @sourceLanguage, @sourceText, @targetLanguage, @targetText
        )`
      )
      .run(turn);
  }

  latestTurns(roomId: string, limit = 3): Array<{ sourceText: string; targetText: string }> {
    return this.db
      .prepare(
        `SELECT source_text AS sourceText, target_text AS targetText
         FROM turns
         WHERE room_id = @roomId
         ORDER BY id DESC
         LIMIT @limit`
      )
      .all({ roomId, limit }) as Array<{ sourceText: string; targetText: string }>;
  }

  insertCorrection(correction: CorrectionRecord) {
    this.db
      .prepare(
        `INSERT INTO corrections(room_id, user_id, wrong_text, right_text, context)
         VALUES(@roomId, @userId, @wrongText, @rightText, @context)`
      )
      .run(correction);
  }

  latestCorrections(roomId: string, limit = 20): Array<{ wrongText: string; rightText: string; context: string }> {
    return this.db
      .prepare(
        `SELECT wrong_text AS wrongText, right_text AS rightText, context
         FROM corrections
         WHERE room_id = @roomId
         ORDER BY id DESC
         LIMIT @limit`
      )
      .all({ roomId, limit }) as Array<{ wrongText: string; rightText: string; context: string }>;
  }

  close() {
    this.db.close();
  }
}

