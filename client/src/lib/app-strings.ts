import type { SupportedLanguage } from "@family-translation/shared";

/** All UI copy after onboarding follows the user’s chosen app language. */
export type AppCopy = {
  pageTitle: string;
  compactView: string;
  showControls: string;
  copyDebugBlob: string;
  enableAudioPlayback: string;
  online: string;
  offline: string;
  displayNameLabel: string;
  displayNamePlaceholder: string;
  languageLabel: string;
  langEnglish: string;
  langJapanese: string;
  hearTtsLabel: string;
  contextNotesLabel: string;
  connect: string;
  disconnect: string;
  sessionHeading: string;
  compactName: string;
  compactLanguage: string;
  compactTts: string;
  ttsOn: string;
  ttsOff: string;
  liveSpeechHeading: string;
  saySomethingPlaceholder: string;
  sendUtterance: string;
  startSimulator: string;
  stopSimulator: string;
  startMicTest: string;
  stopMicTest: string;
  messagesSent: string;
  micTestStateLabel: string;
  micTestIdle: string;
  micTestCapturing: string;
  glossaryHeading: string;
  termLabel: string;
  translationLabel: string;
  notesLabel: string;
  saveGlossary: string;
  correctionHeading: string;
  wrongOutputLabel: string;
  correctOutputLabel: string;
  contextLabel: string;
  submitCorrection: string;
  providerHeading: string;
  sttLabel: string;
  translationProviderLabel: string;
  ttsProviderLabel: string;
  applyProviders: string;
  transcriptHeading: string;
  yourSpeechLive: string;
  sourceTextAria: string;
  iphoneChecklistHeading: string;
  iphoneChecklist1: string;
  iphoneChecklist2: string;
  iphoneChecklist3: string;
  statusNotConnected: string;
  statusSetNameFirst: string;
  statusSocketConnected: string;
  statusConnected: string;
  statusSocketDisconnected: string;
  statusGlossarySaved: string;
  statusCorrectionSubmitted: string;
  statusConnectForAutopilot: string;
  statusConnectBeforeMic: string;
  statusMicFailed: string;
  statusDebugCopied: string;
  statusDebugCopyFailed: string;
  reconnect: string;
  micWarmupTitle: string;
  micWarmupBody: string;
  micWarmupAction: string;
  menuAria: string;
  drawerTitle: string;
  drawerClose: string;
  pttReady: string;
  pttRecording: string;
  pttDisabled: string;
  loadingHistory: string;
  loadingOlder: string;
  showOriginal: string;
  hideOriginal: string;
  chatConversation: string;
  editMessage: string;
  saveEdit: string;
  cancelEdit: string;
  editedMessage: string;
  unseenEditsAbove: string;
  onboardingLangLineEn: string;
  onboardingLangLineJa: string;
  onboardingPickEnglish: string;
  onboardingPickJapanese: string;
  onboardingUnderstandPromptFromEn: string;
  onboardingUnderstandPromptFromJa: string;
  onboardingUnderstandYes: string;
  onboardingUnderstandNo: string;
  onboardingNamePrompt: string;
  onboardingNamePlaceholder: string;
  onboardingContinue: string;
  onboardingBack: string;
  onboardingNameRequired: string;
  onboardingGlossaryWarning: string;
};

const EN: AppCopy = {
  pageTitle: "Family Translation",
  compactView: "Compact view",
  showControls: "Show controls",
  copyDebugBlob: "Copy debug blob",
  enableAudioPlayback: "Enable audio playback",
  online: "Online",
  offline: "Offline",
  displayNameLabel: "Display name",
  displayNamePlaceholder: "Alex",
  languageLabel: "Language",
  langEnglish: "English",
  langJapanese: "Japanese",
  hearTtsLabel: "Hear translated audio (TTS)",
  contextNotesLabel: "Context notes (people, terms, pronunciation hints)",
  connect: "Connect",
  disconnect: "Disconnect",
  sessionHeading: "Session",
  compactName: "Name",
  compactLanguage: "Language",
  compactTts: "TTS",
  ttsOn: "On",
  ttsOff: "Off",
  liveSpeechHeading: "Live speech-to-text",
  saySomethingPlaceholder: "Say something…",
  sendUtterance: "Send utterance",
  startSimulator: "Start simulator",
  stopSimulator: "Stop simulator",
  startMicTest: "Start mic test",
  stopMicTest: "Stop mic test",
  messagesSent: "Messages sent",
  micTestStateLabel: "Mic test state",
  micTestIdle: "idle",
  micTestCapturing: "capturing audio",
  glossaryHeading: "Glossary entry",
  termLabel: "Term",
  translationLabel: "Translation",
  notesLabel: "Notes",
  saveGlossary: "Save glossary",
  correctionHeading: "Correction feedback",
  wrongOutputLabel: "Wrong output",
  correctOutputLabel: "Correct output",
  contextLabel: "Context",
  submitCorrection: "Submit correction",
  providerHeading: "Provider controls (operator)",
  sttLabel: "STT",
  translationProviderLabel: "Translation",
  ttsProviderLabel: "TTS",
  applyProviders: "Apply providers",
  transcriptHeading: "Transcript",
  yourSpeechLive: "Your speech (live draft)",
  sourceTextAria: "Source text and time",
  iphoneChecklistHeading: "iPhone reliability checklist",
  iphoneChecklist1: "Install via Add to Home Screen; keep the app in the foreground while conversing.",
  iphoneChecklist2: "Disable auto-lock during conversation sessions.",
  iphoneChecklist3: "If audio stalls, tap Disconnect then Connect to resume the session.",
  statusNotConnected: "Not connected",
  statusSetNameFirst: "Set your display name first.",
  statusSocketConnected: "Socket connected",
  statusConnected: "Connected",
  statusSocketDisconnected: "Socket disconnected — stop and restart the mic if you were speaking.",
  statusGlossarySaved: "Glossary saved",
  statusCorrectionSubmitted: "Correction submitted",
  statusConnectForAutopilot: "Connect first before starting the simulator.",
  statusConnectBeforeMic: "Connect first before starting mic test.",
  statusMicFailed: "Mic access failed. Check browser microphone permissions.",
  statusDebugCopied: "Debug blob copied to clipboard.",
  statusDebugCopyFailed: "Could not copy debug blob. Retry in Safari app context.",
  reconnect: "Reconnect",
  micWarmupTitle: "Enable microphone and audio",
  micWarmupBody: "Please allow microphone and playback now so talking works immediately.",
  micWarmupAction: "Enable now",
  menuAria: "Open settings menu",
  drawerTitle: "Settings",
  drawerClose: "Close",
  pttReady: "Tap to speak — green means you can start",
  pttRecording: "Tap to stop — recording",
  pttDisabled: "Connect in the menu before speaking",
  loadingHistory: "Loading conversation…",
  loadingOlder: "Loading older messages…",
  showOriginal: "Show original",
  hideOriginal: "Hide original",
  chatConversation: "Conversation",
  editMessage: "Edit message",
  saveEdit: "Save",
  cancelEdit: "Cancel",
  editedMessage: "Edited",
  unseenEditsAbove: "Updated message above — tap to dismiss",
  onboardingLangLineEn: "What is your preferred language?",
  onboardingLangLineJa: "ご希望の言語は何ですか？",
  onboardingPickEnglish: "English",
  onboardingPickJapanese: "日本語",
  onboardingUnderstandPromptFromEn: "Do you understand Japanese?",
  onboardingUnderstandPromptFromJa: "英語はわかりますか？",
  onboardingUnderstandYes: "Yes",
  onboardingUnderstandNo: "No",
  onboardingNamePrompt: "What is your name?",
  onboardingNamePlaceholder: "e.g. Kosono",
  onboardingContinue: "Continue",
  onboardingBack: "Back",
  onboardingNameRequired: "Please enter the name your family should see.",
  onboardingGlossaryWarning:
    "Could not save your name on the server yet. You can add it under Glossary after you connect."
};

const JA: AppCopy = {
  ...EN,
  pageTitle: "ファミリー翻訳",
  compactView: "コンパクト表示",
  showControls: "詳細を表示",
  copyDebugBlob: "デバッグをコピー",
  enableAudioPlayback: "音声再生を有効にする",
  online: "オンライン",
  offline: "オフライン",
  displayNameLabel: "表示名",
  displayNamePlaceholder: "花子",
  languageLabel: "言語",
  langEnglish: "英語",
  langJapanese: "日本語",
  hearTtsLabel: "翻訳音声（TTS）を聞く",
  contextNotesLabel: "コンテキスト（人名・用語・発音メモ）",
  connect: "接続",
  disconnect: "切断",
  sessionHeading: "セッション",
  compactName: "名前",
  compactLanguage: "言語",
  compactTts: "TTS",
  ttsOn: "オン",
  ttsOff: "オフ",
  liveSpeechHeading: "ライブ音声入力",
  saySomethingPlaceholder: "何か話す…",
  sendUtterance: "発話を送る",
  startSimulator: "シミュレーターを開始",
  stopSimulator: "シミュレーターを停止",
  startMicTest: "マイクテスト",
  stopMicTest: "マイクテスト停止",
  messagesSent: "送信したメッセージ数",
  micTestStateLabel: "マイクテストの状態",
  micTestIdle: "待機中",
  micTestCapturing: "録音中",
  glossaryHeading: "用語集エントリ",
  termLabel: "用語",
  translationLabel: "訳・表記",
  notesLabel: "メモ",
  saveGlossary: "用語集に保存",
  correctionHeading: "修正フィードバック",
  wrongOutputLabel: "誤った出力",
  correctOutputLabel: "正しい出力",
  contextLabel: "状況メモ",
  submitCorrection: "修正を送信",
  providerHeading: "プロバイダー（運用）",
  sttLabel: "音声認識",
  translationProviderLabel: "翻訳",
  ttsProviderLabel: "読み上げ",
  applyProviders: "プロバイダーを適用",
  transcriptHeading: "トランスクリプト",
  yourSpeechLive: "あなたの発話（下書き）",
  sourceTextAria: "原文と時刻",
  iphoneChecklistHeading: "iPhoneでの信頼性チェック",
  iphoneChecklist1: "ホーム画面に追加して使い、会話中はアプリを前面に保ってください。",
  iphoneChecklist2: "会話中は自動ロックをオフにしてください。",
  iphoneChecklist3: "音声が止まったら、一度切断してから再接続してください。",
  statusNotConnected: "未接続",
  statusSetNameFirst: "先に表示名を入力してください。",
  statusSocketConnected: "ソケット接続済み",
  statusConnected: "接続済み",
  statusSocketDisconnected:
    "ソケットが切断されました。話していた場合はマイクを止めてから再接続してください。",
  statusGlossarySaved: "用語集に保存しました",
  statusCorrectionSubmitted: "修正を送信しました",
  statusConnectForAutopilot: "シミュレーターを使う前に接続してください。",
  statusConnectBeforeMic: "マイクテストの前に接続してください。",
  statusMicFailed: "マイクにアクセスできませんでした。ブラウザの許可を確認してください。",
  statusDebugCopied: "デバッグをクリップボードにコピーしました。",
  statusDebugCopyFailed: "コピーに失敗しました。Safariのコンテキストで再試行してください。",
  reconnect: "再接続",
  micWarmupTitle: "マイクと音声を有効にする",
  micWarmupBody: "会話をすぐ始められるよう、先にマイクと再生を許可してください。",
  micWarmupAction: "今すぐ有効化",
  menuAria: "設定メニューを開く",
  drawerTitle: "設定",
  drawerClose: "閉じる",
  pttReady: "タップして話す — 緑のときに開始できます",
  pttRecording: "タップして停止 — 録音中",
  pttDisabled: "話す前にメニューから接続してください",
  loadingHistory: "会話を読み込み中…",
  loadingOlder: "古いメッセージを読み込み中…",
  showOriginal: "原文を表示",
  hideOriginal: "原文を隠す",
  chatConversation: "会話",
  editMessage: "メッセージを編集",
  saveEdit: "保存",
  cancelEdit: "キャンセル",
  editedMessage: "編集済み",
  unseenEditsAbove: "上に更新されたメッセージがあります — タップで閉じる",
  onboardingUnderstandYes: "はい",
  onboardingUnderstandNo: "いいえ",
  onboardingNamePrompt: "あなたの名前は何ですか？",
  onboardingNamePlaceholder: "例：コソノ",
  onboardingContinue: "続ける",
  onboardingBack: "戻る",
  onboardingNameRequired: "表示する名前を入力してください。",
  onboardingGlossaryWarning:
    "まだサーバーに名前を保存できませんでした。接続後、用語集から追加できます。"
};

/** Japanese onboarding step labels that stay Japanese in JA mode (Understand yes/no). */
JA.onboardingPickEnglish = EN.onboardingPickEnglish;
JA.onboardingPickJapanese = EN.onboardingPickJapanese;

export function appStrings(lang: SupportedLanguage): AppCopy {
  return lang === "ja" ? JA : EN;
}
