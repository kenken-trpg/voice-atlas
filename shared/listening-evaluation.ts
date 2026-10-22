// Fixed sentences make timing and listening comparisons repeatable. These are
// test scripts, not engine-specific emotion commands or measured voice profiles.
export const listeningSentenceRevision = 'ja-dialogue-v1';
export const listeningSentences = [
  {
    id: 'greeting',
    purpose: '通常の会話',
    text: 'こんにちは。あなたに会えて、とてもうれしいです。',
  },
  {
    id: 'narration',
    purpose: '落ち着いた語り',
    text: '夜が明けるころ、一行は静かな森の入り口にたどり着きました。',
  },
  { id: 'question', purpose: '疑問文と語尾', text: 'この先に、まだ誰かがいるのでしょうか？' },
  {
    id: 'urgent',
    purpose: '緊迫した短いセリフ',
    text: '待ってください！　その扉を開けてはいけません。',
  },
  {
    id: 'names',
    purpose: '固有名詞・数字',
    text: 'リュシアさん、北の塔へ向かいましょう。出発は午後三時です。',
  },
  {
    id: 'pause',
    purpose: '間と長い文',
    text: 'そうですね……。今すぐ答えは出せませんが、もう一度、みんなで考えてみましょう。',
  },
] as const;
