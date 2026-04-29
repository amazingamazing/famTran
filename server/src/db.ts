import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { SupportedLanguage } from "@family-translation/shared";

/** Single shared family session — no room scoping. */
export type TurnRecord = {
  turnId: string;
  speakerId: string;
  speakerName: string;
  sourceLanguage: SupportedLanguage;
  sourceText: string;
  targetLanguage: SupportedLanguage;
  targetText: string;
};

export type CorrectionRecord = {
  userId: string;
  wrongText: string;
  rightText: string;
  context: string;
};

export type HistoryRow = {
  id: number;
  turnId: string;
  speakerId: string;
  speakerName: string;
  sourceLanguage: SupportedLanguage;
  originalText: string;
  targetLanguage: SupportedLanguage;
  translatedText: string;
  createdAt: number;
  editedAt?: number;
};

const SCHEMA_VERSION = 4;

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
    let userVersion = typeof versionRaw === "number" ? versionRaw : Number(versionRaw);

    if (userVersion < 2) {
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
          speaker_name TEXT NOT NULL DEFAULT '',
          source_language TEXT NOT NULL,
          source_text TEXT NOT NULL,
          target_language TEXT NOT NULL,
          target_text TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          edited_at INTEGER
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
      userVersion = SCHEMA_VERSION;
    } else if (userVersion === 2) {
      this.db.exec(`ALTER TABLE turns ADD COLUMN speaker_name TEXT NOT NULL DEFAULT ''`);
      this.db.exec(`ALTER TABLE turns ADD COLUMN edited_at INTEGER`);
      userVersion = SCHEMA_VERSION;
    } else if (userVersion === 3) {
      this.db.exec(`ALTER TABLE turns ADD COLUMN edited_at INTEGER`);
      userVersion = SCHEMA_VERSION;
    }

    if (userVersion !== SCHEMA_VERSION) {
      throw new Error(`Unexpected SQLite user_version ${userVersion}; expected ${SCHEMA_VERSION}`);
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  getTurnForEdit(
    turnId: string
  ): { turnId: string; speakerId: string; speakerName: string; sourceLanguage: SupportedLanguage; targetLanguages: SupportedLanguage[] } | null {
    const rows = this.db
      .prepare(
        `SELECT turn_id AS turnId, speaker_id AS speakerId, speaker_name AS speakerName,
                source_language AS sourceLanguage, target_language AS targetLanguage
         FROM turns
         WHERE turn_id = @turnId`
      )
      .all({ turnId }) as Array<{
      turnId: string;
      speakerId: string;
      speakerName: string;
      sourceLanguage: SupportedLanguage;
      targetLanguage: SupportedLanguage;
    }>;
    if (rows.length === 0) {
      return null;
    }
    const first = rows[0];
    return {
      turnId: first.turnId,
      speakerId: first.speakerId,
      speakerName: first.speakerName,
      sourceLanguage: first.sourceLanguage,
      targetLanguages: [...new Set(rows.map((row) => row.targetLanguage))]
    };
  }

  getTurnRow(
    turnId: string,
    targetLanguage: SupportedLanguage
  ): {
    turnId: string;
    speakerId: string;
    speakerName: string;
    sourceLanguage: SupportedLanguage;
    sourceText: string;
    targetLanguage: SupportedLanguage;
    targetText: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT turn_id AS turnId, speaker_id AS speakerId, speaker_name AS speakerName,
                source_language AS sourceLanguage, source_text AS sourceText,
                target_language AS targetLanguage, target_text AS targetText
         FROM turns
         WHERE turn_id = @turnId
           AND target_language = @targetLanguage
         LIMIT 1`
      )
      .get({ turnId, targetLanguage }) as
      | {
          turnId: string;
          speakerId: string;
          speakerName: string;
          sourceLanguage: SupportedLanguage;
          sourceText: string;
          targetLanguage: SupportedLanguage;
          targetText: string;
        }
      | undefined;
    return row ?? null;
  }

  updateTurnEditedTranslation(args: {
    turnId: string;
    targetLanguage: SupportedLanguage;
    sourceText: string;
    targetText: string;
    editedAtSec: number;
  }) {
    this.db
      .prepare(
        `UPDATE turns
         SET source_text = @sourceText,
             target_text = @targetText,
             edited_at = @editedAtSec
         WHERE turn_id = @turnId
           AND target_language = @targetLanguage`
      )
      .run(args);
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
          turn_id, speaker_id, speaker_name, source_language, source_text, target_language, target_text
        ) VALUES(
          @turnId, @speakerId, @speakerName, @sourceLanguage, @sourceText, @targetLanguage, @targetText
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

  /**
   * Paginated history for one viewer language (`target_language` rows).
   * Returns chronological order (oldest → newest within this batch).
   */
  historyForLanguage(
    language: SupportedLanguage,
    args: { beforeExclusive?: number; limit: number }
  ): HistoryRow[] {
    const limit = Math.min(Math.max(args.limit, 1), 100);
    const beforeExclusive = args.beforeExclusive ?? 9_007_199_254_740_991; // < 2^53, safe for SQLite binding

    const rows = this.db
      .prepare(
        `SELECT id,
                turn_id AS turnId,
                speaker_id AS speakerId,
                speaker_name AS speakerName,
                source_language AS sourceLanguage,
                source_text AS sourceText,
                target_language AS targetLanguage,
                target_text AS targetText,
                created_at AS createdAtSec,
                edited_at AS editedAtSec
         FROM turns
         WHERE target_language = @language
           AND id < @beforeExclusive
         ORDER BY id DESC
         LIMIT @limit`
      )
      .all({
        language,
        beforeExclusive,
        limit
      }) as Array<{
      id: number;
      turnId: string;
      speakerId: string;
      speakerName: string;
      sourceLanguage: SupportedLanguage;
      sourceText: string;
      targetLanguage: SupportedLanguage;
      targetText: string;
      createdAtSec: number;
      editedAtSec?: number | null;
    }>;

    const chronological = [...rows].reverse();
    return chronological.map((row) => ({
      id: row.id,
      turnId: row.turnId,
      speakerId: row.speakerId,
      speakerName: row.speakerName.trim() || row.speakerId.slice(0, 8),
      sourceLanguage: row.sourceLanguage,
      originalText: row.sourceText,
      targetLanguage: row.targetLanguage,
      translatedText: row.targetText,
      createdAt: row.createdAtSec * 1000,
      editedAt: row.editedAtSec ? row.editedAtSec * 1000 : undefined
    }));
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
