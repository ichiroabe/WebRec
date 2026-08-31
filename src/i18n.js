// WebRec: 表示言語の切り替え。
// chrome.i18n は「ブラウザの言語に従う」仕組みで利用者が切り替えられないため、
// 独自に言語設定を持ち、chrome.storage.local に保存する。
//
// 使い方:
//   HTML  … <span data-i18n="キー"></span>（属性は data-i18n-title / -placeholder / -html）
//   JS    … t('キー', { n: 3 })

const LANG_KEY = 'webrec_lang';

export const LANGS = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: 'English' },
];

const MESSAGES = {
  ja: {
    // --- 共通 ---
    'app.name': 'WebRec',
    'app.managerTitle': 'WebRec - スクリプト管理',
    'app.managerHeading': '● WebRec スクリプト管理',
    'common.save': '保存',
    'common.copy': 'コピー',
    'common.download': 'ダウンロード',
    'common.delete': '削除',
    'common.revert': '元に戻す',
    'common.saved': '保存しました',
    'common.copied': 'コピーしました',
    'common.language': '言語',

    // --- ポップアップ ---
    'popup.idleHint': '現在表示中のページを開始URLとして、画面操作の記録を開始します。',
    'popup.otherTabHint': '別のタブで記録中です。そのタブを開いて操作を続けてください。',
    'popup.start': '● 記録を開始',
    'popup.recording': '記録中…',
    'popup.stepCount': '{n} ステップ',
    'popup.startUrl': '開始URL: {url}',
    'popup.stop': '■ 記録を停止して保存',
    'popup.savedWithSteps': '保存しました（{n} ステップ）',
    'popup.openManager': '管理画面で開く',
    'popup.openManagerLink': '📋 スクリプト管理を開く',
    'popup.replayHere': '▶ このタブで再生',
    'popup.replayHereHint': 'ログインなど下準備を済ませたこのタブを、そのまま再生先にします。',
    'popup.errNotHttp': 'このページでは記録を開始できません（http/https のページで開始してください）',
    'popup.errStart': '記録を開始できませんでした',
    'popup.errStop': '記録を停止できませんでした',

    // --- バックグラウンド ---
    'bg.alreadyRecording': 'すでに録画中です',
    'bg.notRecording': '録画は開始されていません',
    'bg.cannotObserve': 'このページを監視できませんでした。ページを再読み込みしてからお試しください。',
    'bg.defaultName': '録画 {when}',
    'bg.tabGone': '再生用のタブが見つかりません（再生中のウィンドウを閉じませんでしたか？）',
    'bg.loadTimeout': 'ページ読み込みがタイムアウトしました',
    'bg.frameNotFound': '対象のフレームが見つかりません',
    'bg.stepFailed': 'ステップを実行できませんでした',
    'bg.injectTimeout': 'ページへの注入が返ってきませんでした（読み込みが終わらないページの可能性があります）',
    'bg.replayBusy': '別の再生が実行中です。終わってからお試しください。',
    'bg.assertTextFailed': '文言が一致しません。期待「{expected}」 実際「{actual}」',
    'bg.assertNotVisible': '要素が見えていません: {selector}',
    'bg.assertStillThere': '要素が消えていません: {selector}',
    'bg.recordingNotFound': '録画が見つかりません',
    'bg.newTabNotOpened': '新しいタブが開きませんでした',
    'bg.fileTooLarge': 'ファイルが大きすぎて保存されていません: {name}',
    'bg.fileMissing': 'ファイルの中身が保存されていません: {name}',
    'bg.fileNotStored': '保存済みファイルが見つかりません: {name}',
    'bg.badSelectorPrefix': '不正なセレクタ: ',
    'bg.notFoundPrefix': '要素が見つかりません: ',
    'bg.fileMissingPrefix': 'ファイルの中身が保存されていません: ',

    // --- 記録中のオーバーレイ（content script は module ではないため content.js 側にも同じ文言を持つ） ---
    'overlay.recording': 'WebRec 録画中',
    'overlay.stop': '■ 停止',

    // --- 一覧 ---
    'list.import': 'インポート',
    'list.exportAll': '全件エクスポート',
    'list.runs': '📋 実行ログ',
    'list.schedules': '⏰ スケジュール',
    'list.settings': '⚙ 設定',
    'list.colName': '名前',
    'list.colNameHint': '（クリックで変更）',
    'list.colStartUrl': '開始URL',
    'list.colCreatedAt': '作成日時',
    'list.colSteps': 'ステップ数',
    'list.colActions': '操作',
    'list.empty': '保存された録画はまだありません。拡張機能アイコンから「記録を開始」してください。',
    'list.count': '{n} 件',
    'list.view': '表示',
    'list.replay': '▶ 再生',
    'list.renameTitle': '名前を変更（Enter で確定 / Esc で取り消し）',
    'list.nameAria': '録画の名前',
    'list.confirmDelete': '「{name}」を削除しますか？',

    // --- タブ ---
    'tab.steps': 'ステップ一覧',
    'tab.json': 'JSON（編集可）',
    'tab.dataset': 'データ（繰り返し）',
    'tab.datasetWithCount': 'データ（繰り返し） ●{n}行',
    'tab.recSettings': 'この録画の設定',
    'tab.recSettingsWithCount': 'この録画の設定 ●{n}',
    'tab.playwright': 'Playwright',
    'tab.puppeteer': 'Puppeteer',

    // --- ステップ一覧 ---
    'steps.openStartUrl': '開始URLを開く -> {url}',
    'steps.useCurrentPage': '今表示しているページからそのまま開始',
    'steps.jumpHint': 'クリックすると JSON の該当箇所を表示します',
    'steps.flagDisabled': '無効',
    'steps.flagOptional': '任意',
    'steps.nowIs': ' → 現在は "{value}"',
    'steps.saveFile': '⭳ {name} を保存',
    'steps.saveFileTitle': 'このファイルを取り出します（書き出したスクリプトの files/ に置いてください）',
    'steps.fileMissing': '「{name}」の中身が保存されていません',
    'steps.insertWait': '＋ 待機',
    'steps.insertWaitTitle': 'このステップの前に待機を差し込みます',
    'steps.insertWaitPrompt': '何秒待ちますか？（小数可）',
    'steps.insertWaitInvalid': '正の数を入力してください',
    'steps.insertWaitDone': '{sec} 秒の待機を差し込みました',
    'steps.deleteStep': '✕ 削除',
    'steps.deleteStepTitle': 'このステップを消します（元に戻せません）',
    'steps.deleteStepConfirm': 'ステップ {n} を削除しますか？\n\n  {summary}',
    'steps.deleteStepDone': 'ステップ {n} を削除しました',
    'steps.disable': '⃠ 無効化',
    'steps.disableTitle': '消さずに、このステップだけ飛ばすようにします',
    'steps.disableDone': 'このステップを飛ばすようにしました',
    'steps.enable': '↺ 有効化',
    'steps.enableTitle': 'このステップをまた実行するようにします',
    'steps.enableDone': 'このステップを実行するようにしました',
    'steps.tidy': '整理',
    'steps.tidyConfirm': '連続する同じ操作 {n} 件を、最後の1件にまとめますか？\n\n（同じ欄への連続入力・連続スクロールが対象です）',
    'steps.tidyDone': '{n} 件をまとめました',
    'steps.tidyNothing': 'まとめられる連続操作はありませんでした',
    'steps.insertAssert': '＋ 検証',
    'steps.insertAssertTitle': 'このステップの直後に「文言の確認」を差し込みます',
    'steps.insertAssertPrompt': '{selector} に、この時点で表示されているはずの文言を入れてください（部分一致）',
    'steps.insertAssertNoTarget': 'このステップには確認できる対象がありません',
    'steps.insertAssertEmpty': '確認したい文言を入力してください',
    'steps.insertAssertDone': '検証ステップを差し込みました',

    // --- JSON タブ ---
    'json.hint':
      'JSON がスクリプトの本体です。編集して「保存」するとこの録画に反映されます。<br />' +
      'ステップに <code>"disabled": true</code>（そのステップを飛ばす）、<code>"optional": true</code>（失敗しても続行）、' +
      '<code>"timeoutMs"</code>（この要素だけ待ち時間を変更）、<code>"waitBeforeMs"</code>（実行前に待つ）を個別に指定できます。<br />' +
      '<code>{"type":"wait","ms":5000}</code> や <code>{"type":"waitForSelector","selector":"#done","timeoutMs":120000}</code>' +
      ' を差し込めば、重い処理の完了を個別に待てます。<br />' +
      '<b>検証ステップ</b>: <code>{"type":"assertText","selector":"#msg","value":"削除しました"}</code>' +
      '（<code>"match":"equals"</code> で完全一致）、<code>{"type":"assertVisible","selector":"#ok"}</code>、' +
      '<code>{"type":"assertMissing","selector":"#row-3"}</code>。期待と違えばその場で止まります。<br />' +
      '<b>代替セレクタ</b>: <code>"selectors": ["#id", "a[href=\'x.php\']", "a:text(\'受信箱\')"]</code> と書くと上から順に試します' +
      '（<code>タグ:text("表示文字")</code> は候補が1つに絞れるときだけ使われます）。',
    'json.varsSummary': '入力値に使える変数（本日日付など）',
    'json.varsHint':
      '<code>value</code> や <code>url</code> に書くと、再生のたびに実行時の値へ置き換わります。' +
      '書き出した Playwright / Puppeteer スクリプトでも同じように動きます。',
    'json.validate': '検証',
    'json.noIssues': '問題は見つかりませんでした',
    'json.notSavedDueToErrors': 'エラーがあるため保存していません',
    'json.levelError': 'エラー',
    'json.levelWarning': '警告',
    'json.levelInfo': '情報',
    'json.issueJumpHint': 'クリックで該当ステップへ移動',
    'json.summaryErrors': 'エラー {n}',
    'json.summaryWarnings': '警告 {n}',
    'json.summaryInfos': '情報 {n}',

    // --- データタブ ---
    'dataset.hint':
      '表の1行につきシナリオを1回ずつ実行します。ステップの値に <code>{{data.列名}}</code> と書くと、' +
      'その行の値に置き換わります（<code>{{row}}</code> は何行目かの番号）。<br />' +
      '例: 列名 <code>氏名</code> なら <code>{"type":"input","selector":"#name","value":"{{data.氏名}}"}</code>',
    'dataset.importCsv': 'CSV/TSV を貼り付けて取り込む',
    'dataset.clear': 'データを削除（1回だけ実行に戻す）',
    'dataset.none': 'データなし（1回だけ実行）',
    'dataset.shape': '{rows} 行 × {cols} 列',
    'dataset.csvPrompt': 'CSV または TSV を貼り付けてください（1行目が列名）',
    'dataset.csvNoRows': 'データ行がありません',
    'dataset.csvLoaded': '{n} 行を読み込みました（「保存」で確定）',
    'dataset.savedRows': '{n} 行を保存しました',
    'dataset.deleted': 'データを削除しました',
    'dataset.confirmClear': 'データを削除して、1回だけ実行する形に戻しますか？',

    // --- 録画ごとの設定 ---
    'recSettings.hint':
      'この録画だけに適用される設定です。「全体設定に従う」のチェックを外した項目だけが、' +
      '管理画面の「⚙ 設定」より優先されます。特定の画面だけ遅い場合は、JSON タブでステップ個別に' +
      ' <code>timeoutMs</code> を指定することもできます。',
    'recSettings.inherit': ' 全体設定に従う（現在 {value}）',
    'recSettings.clearAll': 'すべて全体設定に戻す',
    'recSettings.cleared': '全体設定に戻しました',

    // --- 全体設定 ---
    'settings.title': '再生の設定',
    'settings.hint':
      'ここでの設定はすべての録画に適用されます。特定の録画だけ変えたい場合は、その録画の JSON に' +
      ' <code>"settings": { "pageLoadTimeoutMs": 120000 }</code> を書き加えてください（そちらが優先されます）。',
    'settings.reset': '初期値に戻す',
    'settings.resetDone': '初期値に戻しました',
    'settings.seqLabel': '次の {{seq}} の値',
    'settings.seqHint':
      '<code>{{seq}}</code> は再生するたびに 1 ずつ増える通し番号です（<code>{{seq:000}}</code> で0埋め）。' +
      '1 を入れると次の再生から振り直します。',
    'settings.pageLoadTimeout': 'ページ読み込み待ち上限 (ms)',
    'settings.pageLoadTimeoutHint': 'サーバー応答が遅いサイトではこの値を大きくしてください。',
    'settings.elementTimeout': '要素の出現待ち上限 (ms)',
    'settings.elementTimeoutHint': '描画に時間がかかる画面ではこの値を大きくしてください。',
    'settings.stepInterval': 'ステップ間の待ち (ms)',
    'settings.stepIntervalHint': '操作ごとの間隔。アニメーションが多い画面では長めが安定します。',
    'settings.injectRetries': '失敗時のリトライ回数',
    'settings.injectRetriesHint': 'ページ遷移と重なって失敗した場合に再試行する回数。',

    // --- 再生 ---
    'replay.title': '再生中:',
    'replay.withRows': '{name}（{n} 行を繰り返し）',
    'replay.rowHeader': '{current}/{total} 行目: {summary}',
    'replay.failed': ' (失敗: {error})',
    'replay.warned': ' (任意ステップのため続行: {error})',
    'replay.skipped': ' (スキップ)',
    'replay.error': '再生中にエラーが発生しました: {error}',
    'replay.noResponse':
      '拡張機能のバックグラウンドから応答がありません。chrome://extensions で WebRec を再読み込みし、'
      + '他に開いている WebRec の管理画面タブを閉じてから、もう一度お試しください。',
    'replay.disconnected': '再生の接続が切れました（この画面を閉じた・拡張機能が再読み込みされた等）。',
    'replay.usedFallback': ' (代替セレクタで特定: {selector})',

    // --- 実行ログ ---
    'runs.title': '実行ログ',
    'runs.hint': '再生 1 回ぶんの結果を残しています。行をクリックすると各ステップの結果が開きます。新しいものから 100 件まで保存します。',
    'runs.clear': 'すべて削除',
    'runs.clearConfirm': '実行ログをすべて削除します。よろしいですか？',
    'runs.empty': 'まだ実行ログはありません。',
    'runs.duration': '{sec} 秒',
    'runs.byHand': '手動',
    'runs.bySchedule': '予定',
    'runs.status.running': '実行中',
    'runs.status.done': '成功',
    'runs.status.failed': '失敗 {n} 件',
    'runs.status.error': '中断',
    'runs.rowPrefix': '{row}行目: ',
    'runs.dialogs': 'ダイアログ: ',
    'runs.dialogPlanned': '（記録どおり）',

    // --- スケジュール ---
    'schedule.title': 'スケジュール',
    'schedule.hint':
      '録画を定期的に再生します。<b>ブラウザが起動している間だけ</b>動き、開始URLから新しいウィンドウで実行します（ログイン操作を含む録画向き）。実行結果は「実行ログ」に残ります。',
    'schedule.empty': 'まだ予定はありません。',
    'schedule.recordingLabel': '録画',
    'schedule.kindLabel': '実行タイミング',
    'schedule.kindDaily': '毎日この時刻に',
    'schedule.kindInterval': '一定の間隔で',
    'schedule.minutes': '分ごと',
    'schedule.add': '＋ 予定を追加',
    'schedule.added': '追加しました',
    'schedule.whenDaily': '毎日 {at}',
    'schedule.whenInterval': '{n} 分ごと',
    'schedule.lastRun': '前回 {when}（{status}）',
    'schedule.neverRun': '未実行',
    'schedule.enabledTitle': '有効 / 無効',
    'schedule.missingRecording': '（録画が削除されています）',

    // --- 再生オプション ---
    'replayOpts.title': '再生',
    'replayOpts.hint':
      'ログインや前準備を手で済ませたタブを再生先に選べます。その場合は「今のページから始める」を有効にすると、開始URLへ移動せずに続きから実行します。',
    'replayOpts.targetLabel': '再生先',
    'replayOpts.targetHint': '新しいウィンドウは常に開始URLから始まります。',
    'replayOpts.newWindow': '新しいウィンドウ（開始URLから）',
    'replayOpts.keepUrl': '今のページから始める（開始URLへ移動しない）',
    'replayOpts.keepUrlHint': 'データを繰り返す設定でも、2行目以降の開始URLへの戻しを行いません。',
    'replayOpts.startAtLabel': '開始ステップ',
    'replayOpts.startAtHint': '手で済ませた前半（ログインなど）を飛ばせます。',
    'replayOpts.fromStart': '最初から',
    'replayOpts.run': '▶ 再生',

    // --- インポート / エクスポート ---
    'io.nothingToExport': 'エクスポートする録画がありません',
    'io.readFailed': 'JSON の読み込みに失敗しました: {error}',
    'io.nothingImported': '取り込める録画がありませんでした。',
    'io.imported': '{n} 件を取り込みました。',
    'io.notImported': '取り込めなかったもの:',
    'io.needsAttention': '確認が必要な点:',
    'io.andMore': '…ほか {n} 件',
    'io.seeValidation': '詳しくは各録画の JSON タブで「検証」を実行してください。',

    // --- ステップの説明（一覧・再生の表示） ---
    'step.navigate': 'ページ遷移 -> {url}',
    'step.wait': '待機: {ms}ms',
    'step.waitForSelector': '要素の出現待ち: {selector}',
    'step.assertTextContains': '検証: {selector} に「{value}」が含まれる',
    'step.assertTextEquals': '検証: {selector} が「{value}」と一致する',
    'step.assertVisible': '検証: {selector} が見えている',
    'step.assertMissing': '検証: {selector} が無い',
    'step.click': 'クリック: {text}{selector}',
    'step.input': '入力: {selector} = "{value}"',
    'step.select': '選択: {selector} = "{value}"',
    'step.selectMultiple': '複数選択: {selector} = [{values}]',
    'step.dragAndDrop': 'ドラッグ&ドロップ: {selector} -> {toSelector}',
    'step.keydown': 'キー入力: {key} ({selector})',
    'step.uploadClear': 'ファイル選択を解除: {selector}',
    'step.upload': 'ファイル選択: {selector} = {names}',
    'step.uploadOmitted': '（中身なし）',
    'step.inFrame': ' [フレーム: {frames}]',
    'step.dblclick': 'ダブルクリック: {text}{selector}',
    'step.contextmenu': '右クリック: {text}{selector}',
    'step.editable': 'リッチテキスト入力: {selector} = "{text}"',
    'step.scrollWindow': 'スクロール: ({x}, {y})',
    'step.scrollElement': 'スクロール: {selector} ({x}, {y})',
    'step.pointerPath': 'マウス軌跡: {selector}（{n} 点）',
    'step.newTab': '新しいタブに移る -> {url}',
    'step.dialogAlert': 'ダイアログ: alert「{message}」を閉じる',
    'step.dialogConfirm': 'ダイアログ: confirm「{message}」で {answer}',
    'step.dialogPrompt': 'ダイアログ: prompt「{message}」に "{answer}" と入力',
    'step.dialogPromptCancel': 'ダイアログ: prompt「{message}」でキャンセル',
    'dialog.ok': 'OK',
    'dialog.cancel': 'キャンセル',

    // --- 検証メッセージ ---
    'v.stepAt': 'ステップ {n}',
    'v.noSteps': 'ステップが1つもありません。再生しても開始URLを開くだけです。',
    'v.allDisabled': 'すべてのステップが無効化されています。',
    'v.emptyDataset': 'データが空です。1回だけの実行になります。',
    'v.datasetRagged': 'データ {row} 行目に列がありません: {columns}',
    'v.badSelector': '{at}: セレクタとして解釈できません: {selector}',
    'v.badToSelector': '{at}: 移動先セレクタが不正です: {selector}',
    'v.badSelectors': '{at}: selectors は 1 つ以上のセレクタの配列にしてください',
    'v.allSelectorsBad': '{at}: selectors の候補がすべて不正です',
    'v.someSelectorsBad': '{at}: selectors に使えない候補が混じっています（残りで再生します）',
    'v.assertNoSelector': '{at}: 検証ステップには selector（または selectors）が必要です',
    'v.assertNoValue': '{at}: assertText には期待する文言を value に書いてください',
    'v.assertBadMatch': '{at}: match は "contains" か "equals" のどちらかです',
    'v.badNumberType': '{at}: {key} は数値で指定してください',
    'v.badNumberNegative': '{at}: {key} に負の値は指定できません',
    'v.badUrl': '{at}: url は http/https で始まる必要があります',
    'v.dialogBadKind': '{at}: ダイアログの種類「{kind}」は alert / confirm / prompt のいずれかである必要があります',
    'v.dialogBadConfirm': '{at}: confirm への応答は true(OK) か false(キャンセル) である必要があります',
    'v.dialogBadPrompt': '{at}: prompt への応答は入力した文字列か、キャンセルを表す null である必要があります',
    'v.emptyValues': '{at}: 複数選択の値が空です（何も選ばれません）',
    'v.disabledAndOptional': '{at}: 無効化されているため optional は効きません',
    'v.passwordPlaceholder': '{at}: <PASSWORD> のままです。実際の値に書き換えてください',
    'v.otpPlaceholder': '{at}: ワンタイムパスワードは記録した数字が使えません。{{totp:シークレット}} に書き換えてください',
    'v.dataNoColumn': '{at}: {var} に列名がありません',
    'v.dataWithoutDataset': '{at}: {var} を使っていますが「データ」タブが空です',
    'v.dataUnknownColumn': '{at}: データに「{column}」列がありません（ある列: {available}）',
    'v.noColumns': 'なし',
    'v.unknownVar': '{at}: {var} は未対応の変数です。そのまま文字列として入力されます',
    'v.unknownVarStartUrl': '開始URL: {var} は未対応の変数です',
    'v.unusedColumn': 'どのステップからも参照されていない列: {columns}',
    'v.uploadTooLarge': '{at}: {name} は大きすぎて保存されていません（8MBまで）',
    'v.uploadNotStored': '{at}: {name} の中身を読み取れませんでした',
    'v.uploadMissing': '{at}: {name} の中身が保存されていません',

    // --- テンプレート変数のヘルプ ---
    'tpl.data': '「データ」タブの現在行の値（繰り返し実行）',
    'tpl.row': '現在が何行目か（1, 2, 3 …）',
    'tpl.rowPadded': '同上を0埋め（001, 002 …）',
    'tpl.date': '本日 (YYYY-MM-DD)',
    'tpl.dateFormat': '書式を指定した本日',
    'tpl.dateOffset': '翌日 (+1d / -3d / +2w / +1m / -1y)',
    'tpl.dateParts': '年・月・日を個別の欄に入れる',
    'tpl.time': '現在時刻',
    'tpl.datetime': '日時 (YYYY-MM-DD HH:mm:ss)',
    'tpl.randomMask': '4桁の乱数 (0埋め)。#### なら0埋めなし',
    'tpl.randomRange': '1〜100 の乱数',
    'tpl.seq': '再生するたびに1増える通し番号（0埋めなし）',
    'tpl.seqPadded': '同上を0埋め（001, 002 …）',
    'tpl.uuid': 'ランダムなUUID',
    'tpl.totp': 'ワンタイムパスワード（認証アプリのシークレットから毎回計算）',
  },

  en: {
    // --- Common ---
    'app.name': 'WebRec',
    'app.managerTitle': 'WebRec - Script Manager',
    'app.managerHeading': '● WebRec Script Manager',
    'common.save': 'Save',
    'common.copy': 'Copy',
    'common.download': 'Download',
    'common.delete': 'Delete',
    'common.revert': 'Revert',
    'common.saved': 'Saved',
    'common.copied': 'Copied',
    'common.language': 'Language',

    // --- Popup ---
    'popup.idleHint': 'Starts recording, using the page you are on now as the start URL.',
    'popup.otherTabHint': 'Recording in another tab. Switch to that tab to continue.',
    'popup.start': '● Start recording',
    'popup.recording': 'Recording…',
    'popup.stepCount': '{n} steps',
    'popup.startUrl': 'Start URL: {url}',
    'popup.stop': '■ Stop and save',
    'popup.savedWithSteps': 'Saved ({n} steps)',
    'popup.openManager': 'Open in manager',
    'popup.openManagerLink': '📋 Open script manager',
    'popup.replayHere': '▶ Replay in this tab',
    'popup.replayHereHint': 'Use this tab — already logged in or set up — as the replay target.',
    'popup.errNotHttp': 'Recording is not available on this page (open an http/https page first)',
    'popup.errStart': 'Could not start recording',
    'popup.errStop': 'Could not stop recording',

    // --- Background ---
    'bg.alreadyRecording': 'Already recording',
    'bg.notRecording': 'Recording has not been started',
    'bg.cannotObserve': 'Could not observe this page. Reload the page and try again.',
    'bg.defaultName': 'Recording {when}',
    'bg.tabGone': 'The replay tab is gone (was the replay window closed?)',
    'bg.loadTimeout': 'The page took too long to load',
    'bg.frameNotFound': 'Could not find the target frame',
    'bg.stepFailed': 'Could not run the step',
    'bg.injectTimeout': 'Injection into the page never returned (the page may never finish loading)',
    'bg.replayBusy': 'Another replay is running. Please wait for it to finish.',
    'bg.assertTextFailed': 'Text did not match. Expected "{expected}", got "{actual}"',
    'bg.assertNotVisible': 'Element is not visible: {selector}',
    'bg.assertStillThere': 'Element is still there: {selector}',
    'bg.recordingNotFound': 'Recording not found',
    'bg.newTabNotOpened': 'No new tab was opened',
    'bg.fileTooLarge': 'Too large to store: {name}',
    'bg.fileMissing': 'The contents of {name} were not stored',
    'bg.fileNotStored': 'The stored file was not found: {name}',
    'bg.badSelectorPrefix': 'Invalid selector: ',
    'bg.notFoundPrefix': 'Element not found: ',
    'bg.fileMissingPrefix': 'File contents were not stored: ',

    // --- Recording overlay (content.js keeps its own copy: it is not a module) ---
    'overlay.recording': 'WebRec recording',
    'overlay.stop': '■ Stop',

    // --- List ---
    'list.import': 'Import',
    'list.exportAll': 'Export all',
    'list.runs': '📋 Run log',
    'list.schedules': '⏰ Schedules',
    'list.settings': '⚙ Settings',
    'list.colName': 'Name',
    'list.colNameHint': '(click to edit)',
    'list.colStartUrl': 'Start URL',
    'list.colCreatedAt': 'Created',
    'list.colSteps': 'Steps',
    'list.colActions': 'Actions',
    'list.empty': 'No recordings yet. Click the extension icon and choose "Start recording".',
    'list.count': '{n} items',
    'list.view': 'View',
    'list.replay': '▶ Replay',
    'list.renameTitle': 'Rename (Enter to confirm / Esc to cancel)',
    'list.nameAria': 'Recording name',
    'list.confirmDelete': 'Delete "{name}"?',

    // --- Tabs ---
    'tab.steps': 'Steps',
    'tab.json': 'JSON (editable)',
    'tab.dataset': 'Data (loop)',
    'tab.datasetWithCount': 'Data (loop) ●{n} rows',
    'tab.recSettings': 'Settings for this recording',
    'tab.recSettingsWithCount': 'Settings for this recording ●{n}',
    'tab.playwright': 'Playwright',
    'tab.puppeteer': 'Puppeteer',

    // --- Steps ---
    'steps.openStartUrl': 'Open start URL -> {url}',
    'steps.useCurrentPage': 'Start from the page currently shown',
    'steps.jumpHint': 'Click to reveal this step in the JSON',
    'steps.flagDisabled': 'disabled',
    'steps.flagOptional': 'optional',
    'steps.nowIs': ' → currently "{value}"',
    'steps.saveFile': '⭳ Save {name}',
    'steps.saveFileTitle': 'Saves this file (put it in files/ next to the exported script)',
    'steps.fileMissing': 'The contents of "{name}" were not stored',
    'steps.insertWait': '＋ Wait',
    'steps.insertWaitTitle': 'Insert a wait before this step',
    'steps.insertWaitPrompt': 'How many seconds? (decimals allowed)',
    'steps.insertWaitInvalid': 'Enter a positive number',
    'steps.insertWaitDone': 'Inserted a {sec}s wait',
    'steps.deleteStep': '✕ Delete',
    'steps.deleteStepTitle': 'Remove this step (cannot be undone)',
    'steps.deleteStepConfirm': 'Delete step {n}?\n\n  {summary}',
    'steps.deleteStepDone': 'Deleted step {n}',
    'steps.disable': '⃠ Disable',
    'steps.disableTitle': 'Skip this step without removing it',
    'steps.disableDone': 'This step will be skipped',
    'steps.enable': '↺ Enable',
    'steps.enableTitle': 'Run this step again',
    'steps.enableDone': 'This step will run again',
    'steps.tidy': 'Tidy up',
    'steps.tidyConfirm': 'Collapse {n} repeated steps into their final value?\n\n(consecutive inputs on one field, and consecutive scrolls)',
    'steps.tidyDone': 'Collapsed {n} steps',
    'steps.tidyNothing': 'Nothing to collapse',
    'steps.insertAssert': '+ Assert',
    'steps.insertAssertTitle': 'Insert a text check right after this step',
    'steps.insertAssertPrompt': 'Text that should be shown in {selector} at this point (substring match)',
    'steps.insertAssertNoTarget': 'This step has nothing to check',
    'steps.insertAssertEmpty': 'Enter the text you want to check',
    'steps.insertAssertDone': 'Assert step inserted',

    // --- JSON tab ---
    'json.hint':
      'The JSON is the script itself. Edit it and press "Save" to update this recording.<br />' +
      'Each step accepts <code>"disabled": true</code> (skip it), <code>"optional": true</code> (continue on failure), ' +
      '<code>"timeoutMs"</code> (wait longer for this element), and <code>"waitBeforeMs"</code> (pause before running).<br />' +
      'Insert <code>{"type":"wait","ms":5000}</code> or <code>{"type":"waitForSelector","selector":"#done","timeoutMs":120000}</code>' +
      ' to wait for a slow operation to finish.<br />' +
      '<b>Assertions</b>: <code>{"type":"assertText","selector":"#msg","value":"deleted"}</code>' +
      ' (<code>"match":"equals"</code> for an exact match), <code>{"type":"assertVisible","selector":"#ok"}</code>,' +
      ' <code>{"type":"assertMissing","selector":"#row-3"}</code>. Replay stops when the page does not match.<br />' +
      '<b>Fallback selectors</b>: <code>"selectors": ["#id", "a[href=\'x.php\']", "a:text(\'Inbox\')"]</code> are tried in order' +
      ' (<code>tag:text("label")</code> is only used when it matches exactly one element).',
    'json.varsSummary': 'Variables you can use in values (today’s date, etc.)',
    'json.varsHint':
      'Write these in <code>value</code> or <code>url</code> and they are resolved at run time, every replay. ' +
      'Exported Playwright / Puppeteer scripts behave the same way.',
    'json.validate': 'Validate',
    'json.noIssues': 'No problems found',
    'json.notSavedDueToErrors': 'Not saved: please fix the errors first',
    'json.levelError': 'Error',
    'json.levelWarning': 'Warning',
    'json.levelInfo': 'Info',
    'json.issueJumpHint': 'Click to jump to this step',
    'json.summaryErrors': '{n} errors',
    'json.summaryWarnings': '{n} warnings',
    'json.summaryInfos': '{n} notes',

    // --- Data tab ---
    'dataset.hint':
      'The scenario runs once per row. Write <code>{{data.column}}</code> in a step value and it is replaced ' +
      'with that row’s value (<code>{{row}}</code> is the row number).<br />' +
      'Example: for a column named <code>name</code>, use <code>{"type":"input","selector":"#name","value":"{{data.name}}"}</code>',
    'dataset.importCsv': 'Paste CSV/TSV',
    'dataset.clear': 'Remove data (run once again)',
    'dataset.none': 'No data (runs once)',
    'dataset.shape': '{rows} rows × {cols} columns',
    'dataset.csvPrompt': 'Paste CSV or TSV (first line is the column names)',
    'dataset.csvNoRows': 'No data rows found',
    'dataset.csvLoaded': 'Loaded {n} rows (press "Save" to apply)',
    'dataset.savedRows': 'Saved {n} rows',
    'dataset.deleted': 'Data removed',
    'dataset.confirmClear': 'Remove the data and go back to running once?',

    // --- Per-recording settings ---
    'recSettings.hint':
      'These apply to this recording only. Fields where you clear "Use global setting" override the ' +
      'values in "⚙ Settings". If only one screen is slow, you can also set <code>timeoutMs</code> on ' +
      'an individual step from the JSON tab.',
    'recSettings.inherit': ' Use global setting (currently {value})',
    'recSettings.clearAll': 'Reset all to global',
    'recSettings.cleared': 'Reset to global settings',

    // --- Global settings ---
    'settings.title': 'Replay settings',
    'settings.hint':
      'These apply to every recording. To change just one recording, add ' +
      '<code>"settings": { "pageLoadTimeoutMs": 120000 }</code> to its JSON (that takes precedence).',
    'settings.reset': 'Restore defaults',
    'settings.resetDone': 'Defaults restored',
    'settings.seqLabel': 'Next {{seq}} value',
    'settings.seqHint':
      '<code>{{seq}}</code> is a counter that increases by 1 on every replay (<code>{{seq:000}}</code> zero-pads it). ' +
      'Set it to 1 to start over on the next replay.',
    'settings.pageLoadTimeout': 'Page load timeout (ms)',
    'settings.pageLoadTimeoutHint': 'Increase this for sites that are slow to respond.',
    'settings.elementTimeout': 'Element wait timeout (ms)',
    'settings.elementTimeoutHint': 'Increase this for screens that take a while to render.',
    'settings.stepInterval': 'Delay between steps (ms)',
    'settings.stepIntervalHint': 'A longer delay is steadier on animation-heavy screens.',
    'settings.injectRetries': 'Retries on failure',
    'settings.injectRetriesHint': 'How many times to retry a step that failed during a page transition.',

    // --- Replay ---
    'replay.title': 'Replaying:',
    'replay.withRows': '{name} ({n} rows)',
    'replay.rowHeader': 'Row {current}/{total}: {summary}',
    'replay.failed': ' (failed: {error})',
    'replay.warned': ' (optional step, continuing: {error})',
    'replay.skipped': ' (skipped)',
    'replay.error': 'An error occurred during replay: {error}',
    'replay.noResponse':
      'No response from the extension background. Reload WebRec on chrome://extensions, close any other WebRec manager tabs, and try again.',
    'replay.disconnected': 'The replay connection was lost (this page was closed, or the extension was reloaded).',
    'replay.usedFallback': ' (found via fallback selector: {selector})',

    // --- Run log ---
    'runs.title': 'Run log',
    'runs.hint': 'One record per replay. Click a row to see each step. The newest 100 runs are kept.',
    'runs.clear': 'Delete all',
    'runs.clearConfirm': 'Delete the entire run log. Are you sure?',
    'runs.empty': 'No runs yet.',
    'runs.duration': '{sec}s',
    'runs.byHand': 'manual',
    'runs.bySchedule': 'scheduled',
    'runs.status.running': 'running',
    'runs.status.done': 'succeeded',
    'runs.status.failed': '{n} failed',
    'runs.status.error': 'aborted',
    'runs.rowPrefix': 'row {row}: ',
    'runs.dialogs': 'Dialogs: ',
    'runs.dialogPlanned': ' (as recorded)',

    // --- Schedules ---
    'schedule.title': 'Schedules',
    'schedule.hint':
      'Replays a recording on a schedule. It runs <b>only while the browser is open</b>, in a new window from the start URL (so include the login steps). Results are kept in the run log.',
    'schedule.empty': 'No schedules yet.',
    'schedule.recordingLabel': 'Recording',
    'schedule.kindLabel': 'When',
    'schedule.kindDaily': 'Every day at',
    'schedule.kindInterval': 'Every N minutes',
    'schedule.minutes': 'min',
    'schedule.add': '+ Add schedule',
    'schedule.added': 'Added',
    'schedule.whenDaily': 'daily at {at}',
    'schedule.whenInterval': 'every {n} min',
    'schedule.lastRun': 'last {when} ({status})',
    'schedule.neverRun': 'not run yet',
    'schedule.enabledTitle': 'Enabled / disabled',
    'schedule.missingRecording': '(recording was deleted)',

    // --- Replay options ---
    'replayOpts.title': 'Replay',
    'replayOpts.hint':
      'You can replay in a tab you prepared by hand (logged in, or already on the right screen). Turn on "start from the page currently shown" to continue from there instead of navigating to the start URL.',
    'replayOpts.targetLabel': 'Replay in',
    'replayOpts.targetHint': 'A new window always starts from the start URL.',
    'replayOpts.newWindow': 'New window (from start URL)',
    'replayOpts.keepUrl': 'Start from the page currently shown (do not open the start URL)',
    'replayOpts.keepUrlHint': 'With a dataset, rows after the first are not reset to the start URL either.',
    'replayOpts.startAtLabel': 'Start at step',
    'replayOpts.startAtHint': 'Skip the steps you already did by hand (login, etc.).',
    'replayOpts.fromStart': 'From the beginning',
    'replayOpts.run': '▶ Replay',

    // --- Import / export ---
    'io.nothingToExport': 'There are no recordings to export',
    'io.readFailed': 'Could not read the JSON: {error}',
    'io.nothingImported': 'No recordings could be imported.',
    'io.imported': 'Imported {n} recordings.',
    'io.notImported': 'Could not import:',
    'io.needsAttention': 'Needs attention:',
    'io.andMore': '…and {n} more',
    'io.seeValidation': 'Run "Validate" on the JSON tab of each recording for details.',

    // --- Step descriptions ---
    'step.navigate': 'Navigate -> {url}',
    'step.wait': 'Wait: {ms}ms',
    'step.waitForSelector': 'Wait for element: {selector}',
    'step.assertTextContains': 'Assert: {selector} contains "{value}"',
    'step.assertTextEquals': 'Assert: {selector} equals "{value}"',
    'step.assertVisible': 'Assert: {selector} is visible',
    'step.assertMissing': 'Assert: {selector} is gone',
    'step.click': 'Click: {text}{selector}',
    'step.input': 'Type: {selector} = "{value}"',
    'step.select': 'Select: {selector} = "{value}"',
    'step.selectMultiple': 'Select multiple: {selector} = [{values}]',
    'step.dragAndDrop': 'Drag and drop: {selector} -> {toSelector}',
    'step.keydown': 'Key press: {key} ({selector})',
    'step.uploadClear': 'Clear file selection: {selector}',
    'step.upload': 'Choose files: {selector} = {names}',
    'step.uploadOmitted': ' (contents not stored)',
    'step.inFrame': ' [in frame: {frames}]',
    'step.dblclick': 'Double-click: {text}{selector}',
    'step.contextmenu': 'Right-click: {text}{selector}',
    'step.editable': 'Rich text: {selector} = "{text}"',
    'step.scrollWindow': 'Scroll to ({x}, {y})',
    'step.scrollElement': 'Scroll {selector} to ({x}, {y})',
    'step.pointerPath': 'Mouse path: {selector} ({n} points)',
    'step.newTab': 'Switch to the new tab -> {url}',
    'step.dialogAlert': 'Dialog: dismiss alert "{message}"',
    'step.dialogConfirm': 'Dialog: confirm "{message}" -> {answer}',
    'step.dialogPrompt': 'Dialog: prompt "{message}" -> type "{answer}"',
    'step.dialogPromptCancel': 'Dialog: prompt "{message}" -> cancel',
    'dialog.ok': 'OK',
    'dialog.cancel': 'Cancel',

    // --- Validation messages ---
    'v.stepAt': 'Step {n}',
    'v.noSteps': 'There are no steps. Replaying will only open the start URL.',
    'v.allDisabled': 'Every step is disabled.',
    'v.emptyDataset': 'The data is empty, so the scenario runs once.',
    'v.datasetRagged': 'Data row {row} is missing columns: {columns}',
    'v.badSelector': '{at}: not a valid selector: {selector}',
    'v.badToSelector': '{at}: the drop target selector is invalid: {selector}',
    'v.badSelectors': '{at}: selectors must be an array with at least one selector',
    'v.allSelectorsBad': '{at}: every candidate in selectors is invalid',
    'v.someSelectorsBad': '{at}: some candidates in selectors are unusable (the rest will be used)',
    'v.assertNoSelector': '{at}: an assert step needs a selector (or selectors)',
    'v.assertNoValue': '{at}: assertText needs the expected text in value',
    'v.assertBadMatch': '{at}: match must be either "contains" or "equals"',
    'v.badNumberType': '{at}: {key} must be a number',
    'v.badNumberNegative': '{at}: {key} cannot be negative',
    'v.badUrl': '{at}: url must start with http or https',
    'v.dialogBadKind': '{at}: dialog kind "{kind}" must be alert, confirm, or prompt',
    'v.dialogBadConfirm': '{at}: the answer to confirm must be true (OK) or false (Cancel)',
    'v.dialogBadPrompt': '{at}: the answer to prompt must be the typed string, or null for Cancel',
    'v.emptyValues': '{at}: the multi-select values are empty (nothing will be selected)',
    'v.disabledAndOptional': '{at}: the step is disabled, so optional has no effect',
    'v.passwordPlaceholder': '{at}: still <PASSWORD>. Replace it with the real value',
    'v.otpPlaceholder': '{at}: a recorded one-time code cannot be reused. Replace it with {{totp:SECRET}}',
    'v.dataNoColumn': '{at}: {var} has no column name',
    'v.dataWithoutDataset': '{at}: {var} is used but the Data tab is empty',
    'v.dataUnknownColumn': '{at}: the data has no "{column}" column (available: {available})',
    'v.noColumns': 'none',
    'v.unknownVar': '{at}: {var} is not a known variable and will be typed as plain text',
    'v.unknownVarStartUrl': 'Start URL: {var} is not a known variable',
    'v.unusedColumn': 'Columns no step refers to: {columns}',
    'v.uploadTooLarge': '{at}: {name} is too large to store (8MB limit)',
    'v.uploadNotStored': '{at}: could not read the contents of {name}',
    'v.uploadMissing': '{at}: the contents of {name} were not stored',

    // --- Template variable help ---
    'tpl.data': 'The current row’s value from the Data tab',
    'tpl.row': 'Which row this is (1, 2, 3 …)',
    'tpl.rowPadded': 'Same, zero-padded (001, 002 …)',
    'tpl.date': 'Today (YYYY-MM-DD)',
    'tpl.dateFormat': 'Today in a custom format',
    'tpl.dateOffset': 'Tomorrow (+1d / -3d / +2w / +1m / -1y)',
    'tpl.dateParts': 'Year, month and day in separate fields',
    'tpl.time': 'Current time',
    'tpl.datetime': 'Date and time (YYYY-MM-DD HH:mm:ss)',
    'tpl.randomMask': '4-digit random number, zero-padded (#### for no padding)',
    'tpl.randomRange': 'Random number from 1 to 100',
    'tpl.seq': 'A counter that increases by 1 on every replay',
    'tpl.seqPadded': 'Same, zero-padded (001, 002 …)',
    'tpl.uuid': 'A random UUID',
    'tpl.totp': 'A one-time code, computed fresh from your authenticator secret',
  },
};

// 起動時に決まり、以降は同期的に参照できるようにしておく
let currentLang = 'ja';

function detectLang() {
  let ui = '';
  try {
    ui = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || '';
  } catch (_) {
    ui = '';
  }
  if (!ui && typeof navigator !== 'undefined') ui = navigator.language || '';
  return String(ui).toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function getLang() {
  return currentLang;
}

// 各ページの起動時に一度だけ呼ぶ
export async function initI18n() {
  try {
    const data = await chrome.storage.local.get(LANG_KEY);
    const saved = data && data[LANG_KEY];
    currentLang = MESSAGES[saved] ? saved : detectLang();
  } catch (_) {
    currentLang = detectLang();
  }
  return currentLang;
}

export async function setLang(lang) {
  if (!MESSAGES[lang]) return currentLang;
  currentLang = lang;
  try {
    await chrome.storage.local.set({ [LANG_KEY]: lang });
  } catch (_) {
    /* 保存できなくても表示は切り替わる */
  }
  return currentLang;
}

// {name} を params の値で置き換える。未定義のキーはキー名をそのまま返して気づけるようにする。
export function t(key, params) {
  const table = MESSAGES[currentLang] || MESSAGES.ja;
  let text = table[key];
  if (text === undefined) text = MESSAGES.ja[key];
  if (text === undefined) return key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  );
}

// data-i18n 属性のついた要素をまとめて置き換える
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  if (root === document) {
    const titleEl = document.querySelector('title[data-i18n]');
    if (titleEl) document.title = t(titleEl.dataset.i18n);
    document.documentElement.lang = currentLang;
  }
}
