# Cursor UI Fidelity Phase 2 — 2026-10-30

## A. GUI受入安定化

T05を再現し、Hostはbusy=false、完了DOMは存在する一方、画面外の完了turnに `content-visibility: auto` が作用し `innerText` に本文が含まれなかったことを確認した。DOMの存在を待ってスクロールし、描画を待った上で既存の表示条件を判定する。失敗証拠は `/private/tmp/ai-phase2-T05/T05/state/timeout.json`。T13再実行ではBuild状態遷移は通過し、最後の300px検査で実幅298pxのままタイムアウトした（`/private/tmp/ai-phase2-T13/T13/flow/timeout.json`）。幅補正の各操作後に実Webview幅の安定を待つ。T19個別実行では12条件すべてでWebviewが298pxのまま、サッシュ操作による幅変更が反映されなかった（`/private/tmp/ai-phase2-T19/T19/matrix.json`）。一括実行では12条件とコンポーネント・Review幅がPASS（`/private/tmp/ai-phase2-all/T19/`）したが、再度の個別実行ではWorkbench sidebarが309〜1172pxへ変化してもWebviewが298pxのまま（`/private/tmp/ai-phase2-retry-T19/T19/matrix.json`）。HostからWebviewへの幅反映が不安定で、直接原因は未確定。T20再実行もHostはReady、完了回答はDOMに存在したが、本文のinnerText待機が失敗した（`/private/tmp/ai-phase2-T20/T20/mock-ready/timeout.json`）。T05と同じスクロール・描画待ちを追加した。過去の失敗が同一原因だったかは確定できない。T13/T20のPlanフローにはHost側がreadyになった直後にWebview側の有効なBuildをクリックする競合があり、描画済み・有効のDOM条件を追加した。revisionもHost状態とDOMの両方を待つ。タイムアウト時は条件、経過時間、Host状態とDOMを保存する。ViewModel fixtureは要求ファイルを部分的に読んだ場合のJSON解析失敗で終了せず、完成した要求を再読する。T19のcomponent fixture準備は応答未確認のまま続行せず明示的に失敗させる。これらは発見した競合の修正であり、過去の各タイムアウトの原因と断定しない。

## B. Cursorとの比較

Cursor 3.26.13 desktop bundleと保存DOMを参照。実測値は既存の400px Dark記録、静的値はdesktop JS/CSSに基づく。Light/HCおよび幅別Cursor実測はない。

| 項目 | Cursor | AI Agents変更前 | AI Agents変更後 | 判定 |
|---|---|---|---|---|
| Model Selector | Modeの隣にtrigger、ラベルとchevron（保存DOM・静的解析） | flex成長で余白が発生 | intrinsic幅で縮小可能、chevronは右 | DIFF：幅別Cursor実測なし |
| Mode Selector | 20px、12px（実測） | 20px、12px | 同左 | PASS：寸法のみ |
| Composer操作行 | 左右配置、28px（実測） | 28px、左グループ内でModelが成長 | 28px、Modelの成長を抑制 | DIFF：全要素の実測なし |
| Composer配色 | 白3.5%相当、枠白20%（Dark実測） | input背景、前景20%枠 | 同左 | DIFF：テーマ依存 |
| User Message | 灰13.5%相当、白12%枠（Dark実測） | input背景、前景12%枠 | 同左 | DIFF：テーマ依存 |
| Activity | rgba(240,240,240,.74)（Dark実測） | descriptionForeground | 同左 | DIFF：テーマ依存 |
| Review | 20px、Composer直上（実測） | 20px、直上、テーマ色 | 同左 | DIFF：色 |

CSSの暗色固定はLight/HCへの影響と合成条件が不明なため行っていない。CursorのJSはbutton areaを生成し、保存DOMにはModeの後にモデルtriggerがある。AI Agentsの共通buttonはアイコンをラベルより先に生成し、row-reverseでchevronを右に置く。従来のflex成長が空白を配分していた。

## C. Plan位置

従来は独立したplan-slotを各renderで末尾に移動した。Plan作成時のユーザーターンIDをPlanDocumentに保持し、ViewPlanへ投影して当該turn直後に置く。revisionは元のIDを引き継ぎ、Buildのturnはその後に並ぶ。保存データにIDがない場合は、一意な過去のplan turnのみ推定し、曖昧な場合は末尾へフォールバックする。Session切替・復元・revision・building・implementedのDOM順序を単体テストで検証した。実Host reloadの検証は下記の受入結果を参照。

## D. 最終回帰

型チェック PASS。Unit 853/853 PASS。Coverage、Hygiene、Build、Integration PASS。Chrome fixture 396シーン・操作22件 PASS。Darkの300/390/600/1000pxではモデルラベル左余白はいずれも6px、ラベル右端とChevron左端の間隔は約3.6px。GUI受入一括はT01〜T19 PASS、T20 FAIL。T20のPlan flowはBuild・位置まで成功したが、300px検査でWebviewが298pxに留まった（`/private/tmp/ai-phase2-all/T20/plan/timeout.json`）。重点シナリオ個別再実行はT05 PASS、T13 FAIL（sidebar 308px、Webview 298px）、T19 FAIL、T20 PASS。T13失敗後にWorkbenchとWebviewの同期待ちを追加し、T20個別実行では同じPlan flowがPASSしたが、T13自体の再実行は未実施。修正後の全件実行内T05のfixtureとMock CLI経路はPASS（`/private/tmp/ai-phase2-all/T05/`）。一括実行のT13はPlan flow（位置、300pxを含む）とsavedPlans reloadがPASS（`/private/tmp/ai-phase2-all/T13/`）。reload後のアンカー位置は実Hostで別途未検証。Cursorの未実測項目と受入未完了項目がある限り最終判定はNO-GO。


最終判定 **NO-GO**。一括実行は19/20 PASSで、T20はその後の個別再実行でPASS。T19のWebview幅反映は断続的に失敗し、修正後のT13の独立再実行および全件再実行は未完了。Cursorとの色・幅別の完全一致、実HostでのReload後のPlan位置は未確認。ライブ認証テストは実行していない。
