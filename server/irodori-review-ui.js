const $ = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
const json = async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};
const runs = await json('/api/runs');
const reviews = await Promise.all(runs.map((run) => json(`/api/review/${run.index}`)));
const comparison = document.querySelector('#comparison');
const reviewRoot = document.querySelector('#reviews');

function label(parent, name, control) {
  const wrapper = $('label', name);
  wrapper.append(control);
  parent.append(wrapper);
  return control;
}
function sampleTitle(run, sample) {
  return `${run.directory.split('/').at(-1)} / ${sample.id} / seed ${sample.seed} / ${sample.steps} step`;
}
function makePlayer(slot) {
  const card = $('section');
  card.className = 'card';
  card.append($('h2', `比較 ${slot}`));
  const select = $('select');
  const audio = $('audio');
  audio.controls = true;
  audio.preload = 'none';
  const details = $('div');
  const playbackError = $('p');
  playbackError.className = 'error';
  audio.addEventListener('error', () => {
    playbackError.textContent =
      'WAVを再生できません。ファイルの検査結果とブラウザーの対応形式を確認してください。';
  });
  for (const run of runs) {
    const group = $('optgroup');
    group.label = `${run.directory.split('/').at(-1)}（${run.status}）`;
    for (const sample of run.samples) {
      const option = $('option', sampleTitle(run, sample));
      option.value = `${run.index}:${sample.id}`;
      group.append(option);
    }
    select.append(group);
  }
  const refresh = () => {
    audio.pause();
    playbackError.textContent = '';
    const [index, id] = select.value.split(':');
    const run = runs[Number(index)];
    const sample = run.samples.find((item) => item.id === id);
    audio.src = `/api/audio/${index}/${id}`;
    details.replaceChildren(
      $('p', sample.text),
      $(
        'p',
        `声の説明: ${sample.caption || '参照音声モード'} / 生成枠: ${run.seconds}秒 / 長さ: ${sample.durationSeconds.toFixed(2)}秒 / 生成: ${(sample.elapsedMs / 1000).toFixed(1)}秒${sample.repeatOf ? ` / 再生成: ${sample.repeatOf}` : ''}`,
      ),
    );
  };
  select.addEventListener('change', refresh);
  label(card, '評価音声', select);
  card.append(audio, playbackError, details);
  comparison.append(card);
  if (slot === 'B' && select.options.length > 1) select.selectedIndex = 1;
  if (select.options.length) refresh();
  else card.append($('p', 'このランには保存済み音声がありません。'));
  return audio;
}
const players = [makePlayer('A'), makePlayer('B')];
for (const player of players)
  player.addEventListener('play', () => {
    for (const other of players) if (other !== player) other.pause();
  });

for (const run of runs) {
  const state = reviews[run.index];
  const card = $('section');
  card.className = 'card';
  card.append($('h2', run.directory.split('/').at(-1)));
  card.append($('p', `${run.mode} / ${run.device} / ${run.status} / ${run.samples.length}件`));
  const summary = $('textarea');
  summary.value = state.review.summary;
  summary.maxLength = 4000;
  label(card, '全体メモ（声の一貫性、用途、残った疑問）', summary);
  const sampleInputs = new Map();
  const list = $('div');
  list.className = 'samples';
  for (const sample of run.samples) {
    const row = $('div');
    row.className = 'sample';
    row.append($('strong', sampleTitle(run, sample)), $('p', sample.text));
    const note = $('textarea');
    note.value = state.review.samples[sample.id] || '';
    note.maxLength = 2000;
    label(row, '聴取メモ（読み、声、間、末尾、音割れ）', note);
    sampleInputs.set(sample.id, note);
    list.append(row);
  }
  card.append(list);
  const status = $('select');
  for (const [value, name] of [
    ['draft', '下書き・未判定'],
    ['reviewed', '聴取済み'],
  ]) {
    const option = $('option', name);
    option.value = value;
    status.append(option);
  }
  status.value = state.review.status;
  label(card, '聴取状態', status);
  const toolbar = $('div');
  toolbar.className = 'toolbar';
  const save = $('button', 'メモを保存');
  const message = $('span');
  save.addEventListener('click', async () => {
    save.disabled = true;
    message.textContent = '保存中…';
    message.className = '';
    try {
      const samples = Object.fromEntries(
        [...sampleInputs]
          .filter(([, input]) => input.value.trim())
          .map(([id, input]) => [id, input.value]),
      );
      const result = await json(`/api/review/${run.index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: state.revision,
          review: { ...state.review, status: status.value, summary: summary.value, samples },
        }),
      });
      Object.assign(state, result);
      message.textContent = `保存しました（${new Date(result.review.updatedAt).toLocaleString('ja-JP')}）`;
    } catch (error) {
      message.textContent = error.message;
      message.className = 'error';
    } finally {
      save.disabled = false;
    }
  });
  toolbar.append(save, message);
  card.append(toolbar);
  reviewRoot.append(card);
}
