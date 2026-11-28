/**
 * 本編の末尾の「データと方法」の節の中身。DOM に依存しない形（`MethodsModel`）で組み立て、`render.ts` が DOM にする。
 * 数値はすべて `facts.ts` の定数から組み立てる（本文と食い違わないように。文面に数字を直接書かない）。
 */
import { DEFAULT_MERGE_DISTANCE_M } from '../../data/stations';
import { COLUMN_BICYCLES_PER_KM } from '../../scene/stationMarkers';
import {
  BUILDING_DISTRICTS,
  coneHeightOnFlatGroundM,
  DATA_YEARS,
  FACTS,
  FIRST_FISCAL_YEAR,
  FISCAL_YEAR,
  LAST_THRESHOLD_YEAR,
  PEAK_YEAR,
  PILE_ASSUMPTIONS,
  PILE_SURFACE_PLACED,
  REMOVED_FY2024_WITH_MOPEDS,
  REPORT_YEARS,
  SOURCES,
  STATION_PILLARS,
  STATION_RADIUS_M,
  SURVEY,
  TOCHO_HEIGHT_M,
  TOKYO_DOME_VOLUME_M3,
  type Fact,
} from '../../story/content/facts';
import { formatDecimal, formatJaCount } from '../../story/content/format';

/** 文の中身。文字列、リンク、強調。 */
export type Inline = string | { text: string; href: string } | { strong: string };

export type Block =
  | { kind: 'p'; content: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'h4'; id: string; text: string };

export interface MethodsSubsection {
  id: string;
  heading: string;
  blocks: Block[];
}

export interface MethodsModel {
  lead: Inline[];
  sections: MethodsSubsection[];
  backToTop: { text: string; href: string };
}

/** 節の見出しの id。出典表示の「データと方法」のリンク（`#data-and-methods`）の移動先は節の要素。 */
export const METHODS_SECTION_ID = 'data-and-methods';
export const METHODS_HEADING_ID = 'data-and-methods-heading';

/** リンク先（すべて https）。 */
export const LINKS = {
  plateau: 'https://www.mlit.go.jp/plateau/',
  gsiTiles: 'https://maps.gsi.go.jp/development/ichiran.html',
  stationsN02: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html',
  threeJs: 'https://threejs.org/',
  surveyList: 'https://www.tomin-anzen.metro.tokyo.lg.jp/kotsu/jitensha/houchi/0000001962',
  surveyFull: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202603_jitensyagenkyo',
  surveySummary: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/202603_jitensyagaiyou_summary',
  surveyStations: 'https://www.tomin-anzen.metro.tokyo.lg.jp/documents/d/tomin-anzen/07ekibetsuhouchi',
  press: 'https://www.metro.tokyo.lg.jp/information/press/2026/03/2026032616',
  tocho: 'https://www.zaimu.metro.tokyo.lg.jp/documents/d/zaimu/20l5k201',
  tokyoDome: 'https://www.tokyo-dome.co.jp/dome/about/',
  containerExport: 'https://ecotopia.earth/article-1045/',
  containerShipment: 'https://www.p4p.org/p4p-bike-150000-the-whole-story/',
} as const;

const F = FACTS;
const PA = PILE_ASSUMPTIONS;

/** 数値を本文の書き方にする（1万以上は「万」。小数は facts の桁数どおり）。 */
function n(f: Fact): string {
  return f.fractionDigits ? formatDecimal(f.value, f.fractionDigits) : formatJaCount(f.value);
}
const nu = (f: Fact): string => `${n(f)}${f.unit}`;

/** m³ の値（0.35 など）。 */
const m3 = (v: number): string => `${formatDecimal(v, 2)}立方メートル`;

/** 山の高さの概算(m)を整数にする。 */
const flatPileHeight = (count: number, unitVolumeM3: number): number =>
  Math.round(coneHeightOnFlatGroundM(count, unitVolumeM3, PA.reposeAngleDeg));

/** 仮定を変えたときの山の高さの幅（平らな地面に円錐として積んだ概算）。 */
export function pileHeightRange(): { containerM3: number; boxM3: number; year: [number, number]; fifteenYears: [number, number] } {
  const lo = PA.reference.containerPerBicycleM3;
  const hi = PA.reference.boxPerBicycleM3;
  return {
    containerM3: lo,
    boxM3: hi,
    year: [flatPileHeight(F.removedFY2024.value, lo), flatPileHeight(F.removedFY2024.value, hi)],
    fifteenYears: [flatPileHeight(F.removed15Years.value, lo), flatPileHeight(F.removed15Years.value, hi)],
  };
}

const link = (text: string, href: string): Inline => ({ text, href });
const strong = (text: string): Inline => ({ strong: text });
const p = (...content: Inline[]): Block => ({ kind: 'p', content });
const ul = (...items: Inline[][]): Block => ({ kind: 'ul', items });
const h4 = (id: string, text: string): Block => ({ kind: 'h4', id, text });

const list = (names: readonly string[]): string => names.join('・');

export function buildMethodsModel(): MethodsModel {
  const range = pileHeightRange();
  const drawnLarge = PILE_SURFACE_PLACED.largeDevice;
  const drawnSmall = PILE_SURFACE_PLACED.smallDevice;
  const drawnShare = (count: number): number => Math.round((count / F.removed15Years.value) * 100);
  const metersPerBicycle = 1000 / COLUMN_BICYCLES_PER_KM;
  const containerBicycles = `${PA.reference.containerBicyclesMin}〜${PA.reference.containerBicyclesMax}台`;
  const years = FISCAL_YEAR - FIRST_FISCAL_YEAR + 1;

  return {
    lead: ['この作品に出てくる数字と絵が、何にもとづき、どこまでが事実で、どこからが仮定なのかを、ここにまとめました。'],
    sections: [
      {
        id: 'about',
        heading: 'この作品について',
        blocks: [
          p('この作品は、個人が非営利で作りました。国土交通省、国土地理院、東京都が作成・監修・保証したものではありません。'),
          p('元のデータは加工して使っています。作品の数字や絵が、元の資料と同じとは限りません。'),
        ],
      },
      {
        id: 'counts',
        heading: '放置自転車の台数：出典と数え方',
        blocks: [
          p('放置自転車の台数は、東京都が公表している次の資料にもとづきます。'),
          ul(
            [link(`東京都 ${SOURCES.full}`, LINKS.surveyFull)],
            [link(`東京都 ${SOURCES.summary}`, LINKS.surveySummary)],
            [link(`東京都 ${SOURCES.stations}`, LINKS.surveyStations)],
            [link(SOURCES.press, LINKS.press)],
            [
              `撤去台数の推移は、平成${REPORT_YEARS.firstHeisei}年度から令和${REPORT_YEARS.lastReiwa}年度までの各年度の調査の報告書。`,
              link('東京都「都内における駅前放置自転車の現況」（資料の一覧）', LINKS.surveyList),
            ],
          ),
          p(strong('数え方')),
          ul(
            [
              strong('いつ数えたか。'),
              `放置台数は、${SURVEY.year}年${SURVEY.month}月に、各区市町村が晴天の平日を1日選び、午前${SURVEY.hour}時ごろに1回数えたものです。1日の合計ではなく、その時点の台数です。島しょ部は含みません。`,
            ],
            [
              strong('どこを数えたか。'),
              `駅からおおむね半径${formatJaCount(STATION_RADIUS_M)}メートル以内で、駐輪場以外の道路に置かれ、利用者がすぐに動かせない状態の自転車です。`,
            ],
            [
              strong('自転車だけの値。'),
              `作品の台数（都内全体で${nu(F.totalParked)}）は自転車だけの値で、原動機付自転車と自動二輪車を含みません。`,
            ],
            [
              strong('駅の数え方。'),
              `調査の表は、複数の区市町村にまたがる駅を区市町村ごとに別の行で数え、近い複数の駅を1行にまとめています。地図の柱は、同じ場所の行を合算し、${DEFAULT_MERGE_DISTANCE_M}メートル以内にある同じ名前の駅もまとめたうえで、放置自転車が1台以上ある${nu(STATION_PILLARS)}に立てています。本文の「${nu(F.stationsWithParked)}」「${nu(F.stationsVacancyExceeds)}」は、表の行の数です。`,
            ],
            [
              strong('撤去台数。'),
              `撤去台数は、区市町村ごとの年度の合計です。駅ごとの値は公表されていません。本文の${FISCAL_YEAR}年度の撤去台数（${nu(F.removedFY2024)}）は自転車だけの値で、原動機付自転車を含む公表値（${nu(REMOVED_FY2024_WITH_MOPEDS)}）より少なくなります。返還・処分の台数には前年度に撤去された分などが含まれ、撤去台数とは一致しません。`,
            ],
            [
              strong('古い年の値。'),
              `${PEAK_YEAR}年の${nu(F.peakParked1990)}は、自転車・原動機付自転車・自動二輪車の計です。${PEAK_YEAR}年の値と${LAST_THRESHOLD_YEAR}年までの値は、自転車は100台以上、原動機付自転車と自動二輪車は合わせて50台以上ある駅だけを数えた当時の方式によります。同じ数え方で${SURVEY.year}年を数えると${nu(F.sameMethodParked2025)}です。`,
            ],
          ),
        ],
      },
      {
        id: 'placement',
        heading: '自転車の置き方：どこまでが事実か',
        blocks: [
          p('統計が教えてくれるのは台数です。自転車がどこに、どのように置かれていたかまでは分かりません。画面の絵は、台数を実感するための図示です。'),
          h4('placement-akihabara', `秋葉原の${nu(F.akihabaraParked)}`),
          p(
            `統計で分かるのは駅の周りの台数だけで、どこに置かれていたかは公表されていません。路上の配置は図示のためのもので、台数（${nu(F.akihabaraParked)}）だけが統計の値と一致しています。`,
          ),
          h4('placement-columns', '駅ごとの柱'),
          p(
            `都内の地図に立つ柱は、駅ごとの放置自転車の台数です。高さは台数に比例し、柱の高さ1キロメートルが${COLUMN_BICYCLES_PER_KM}台（1台あたり${formatJaCount(metersPerBicycle)}メートル）です。実物の大きさでは見えないため、拡大して描いています。柱は${nu(STATION_PILLARS)}で、位置は国土数値情報の駅の位置です。`,
          ),
          h4('placement-piles', '自転車の山'),
          p(
            `山の大きさは、1台が占める体積を${m3(PA.unitVolumeM3)}、山の斜面の角度（安息角）を${PA.reposeAngleDeg}°と仮定し、PLATEAU の建物と国土地理院の標高から作った街の高さのデータの上に積んだ計算の結果です。実際に積んで測った値ではありません。結果は、1年ぶん（${FISCAL_YEAR}年度、${nu(F.removedFY2024)}）の山で高さ約${nu(F.yearPileHeight)}、${years}年ぶん（${nu(F.removed15Years)}）の山で高さ約${nu(F.cumulativePileHeight)}です。`,
          ),
          p(
            `山を積む場所（1年ぶんは東京駅丸の内口の駅前広場、${years}年ぶんは新宿中央公園）は、身近な建物と大きさを比べるために選んだものです。撤去された自転車が、実際にそこに積まれているわけではありません。`,
          ),
          p(
            `山積みの自転車が占める体積を測った資料は見つかりませんでした。${m3(PA.unitVolumeM3)}は、次の2つの目安の間に置いた推定値です。`,
          ),
          ul(
            [
              `小さい側の目安：整然と詰めた輸出用のコンテナ。1台あたり約${m3(PA.reference.containerPerBicycleM3)}。40フィートコンテナに${containerBicycles}（`,
              link('中古自転車の輸出を取材した記事', LINKS.containerExport),
              'と、',
              link('自転車を海外へ送る団体の出荷の記録', LINKS.containerShipment),
              'から）。',
            ],
            [
              `大きい側の目安：1台がちょうど収まる箱の体積。約${m3(PA.reference.boxPerBicycleM3)}。`,
            ],
          ),
          p(
            `斜面の角度も、自転車の山を測った資料は見つかりませんでした。${PA.reposeAngleDeg}°は仮定の値です。`,
          ),
          p(
            '仮定を変えると、山の高さは変わります。平らな地面に円錐として積んだ場合の概算は、次のとおりです。',
          ),
          ul(
            [
              `1台あたり${m3(range.containerM3)}：1年ぶんが約${range.year[0]}メートル、${years}年ぶんが約${range.fifteenYears[0]}メートル`,
            ],
            [
              `1台あたり${m3(range.boxM3)}：1年ぶんが約${range.year[1]}メートル、${years}年ぶんが約${range.fifteenYears[1]}メートル`,
            ],
          ),
          p('画面の山は、街の建物の形を考えて計算しています。そのため、この概算とは一致しません。'),
          h4('placement-surface', `${years}年ぶんの山の描き方`),
          p(
            `${years}年ぶんの山は台数が多いため、山の表面近くの自転車だけを描いています。描いているのは${formatJaCount(drawnLarge.count)}台（表面から深さ${formatDecimal(drawnLarge.surfaceDepthM, 1)}メートルまで。スマートフォンなど小さな端末では${formatJaCount(drawnSmall.count)}台、深さ${formatDecimal(drawnSmall.surfaceDepthM, 1)}メートルまで）で、表している${nu(F.removed15Years)}の約${drawnShare(drawnLarge.count)}％です。山の内側の自転車は描いていません。1年ぶんの山は、${nu(F.removedFY2024)}をすべて置いています。`,
          ),
          h4('placement-falling', '自転車が降ってくる動き'),
          p('自転車が上空から降ってくるのは、量が増えていく様子を見せるための演出です。実際の撤去の方法を表したものではありません。'),
        ],
      },
      {
        id: 'sources',
        heading: '地図と3Dモデル：出典',
        blocks: [
          ul(
            [
              strong('建物。'),
              '出典：',
              link('国土交通省 Project PLATEAU', LINKS.plateau),
              `。3D都市モデル（東京都、${DATA_YEARS.plateauBuildings}年度）の建物と橋梁の形を取り出し、加工して作成しました。色や模様は付けていません。データの著作権は各地方公共団体に帰属します。`,
            ],
            [
              strong('使った区。'),
              `カメラが近づく場所の建物の詳細な形（LOD2）は、${list(BUILDING_DISTRICTS.detail)}。橋梁・高架は、${list(BUILDING_DISTRICTS.bridges)}。遠景の箱形の建物（LOD1）は、${list(BUILDING_DISTRICTS.far)}（${BUILDING_DISTRICTS.far.length}区）です。`,
            ],
            [
              strong('地面の起伏と海岸線。'),
              '出典：',
              link('国土地理院「地理院タイル」（標高タイル）', LINKS.gsiTiles),
              'を加工して作成しました。地面は航空写真を使わない単色の面で、起伏とその陰影を標高タイルから、海岸線を標高タイルの無効値（海）から作っています。',
            ],
            [
              strong('駅の位置。'),
              '出典：',
              link(`国土数値情報（鉄道データ、国土交通省、${DATA_YEARS.stations}年度）`, LINKS.stationsN02),
              'を加工して作成しました。',
            ],
            [
              strong('比べる建物の高さと容積。'),
              `都庁第一本庁舎の高さ（${formatDecimal(TOCHO_HEIGHT_M, 1)}メートル）は`,
              link('東京都財務局の資料', LINKS.tocho),
              `、東京ドームの容積（約${formatJaCount(TOKYO_DOME_VOLUME_M3)}立方メートル）は`,
              link('東京ドームシティの公式サイト', LINKS.tokyoDome),
              'によります。',
            ],
          ),
        ],
      },
      {
        id: 'tech',
        heading: '制作の技術',
        blocks: [
          p(
            '3D の描画には ',
            link('three.js', LINKS.threeJs),
            ' を使っています。PLATEAU の 3D Tiles は、あらかじめ軽い建物のデータに変換して配信しています。山の計算は、お使いの端末の中で行います。画面と処理は TypeScript と Vite で作り、静的なサイトとして公開しています。',
          ),
        ],
      },
    ],
    backToTop: { text: '作品の先頭へ戻る', href: '#top' },
  };
}

/** 文の中身を、リンクや強調を取り除いた文字列にする（単体テストと目次の確認用）。 */
export function inlineText(parts: readonly Inline[]): string {
  return parts.map((x) => (typeof x === 'string' ? x : 'strong' in x ? x.strong : x.text)).join('');
}

/** 節全体の文字列（単体テスト用）。 */
export function modelText(model: MethodsModel): string {
  const out: string[] = [inlineText(model.lead)];
  for (const s of model.sections) {
    out.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === 'p') out.push(inlineText(b.content));
      else if (b.kind === 'h4') out.push(b.text);
      else for (const item of b.items) out.push(inlineText(item));
    }
  }
  out.push(model.backToTop.text);
  return out.join('\n');
}

/** 節の中のリンク先（単体テスト用）。 */
export function modelLinks(model: MethodsModel): string[] {
  const hrefs: string[] = [model.backToTop.href];
  const collect = (parts: readonly Inline[]): void => {
    for (const x of parts) if (typeof x !== 'string' && 'href' in x) hrefs.push(x.href);
  };
  collect(model.lead);
  for (const s of model.sections) {
    for (const b of s.blocks) {
      if (b.kind === 'p') collect(b.content);
      else if (b.kind === 'ul') for (const item of b.items) collect(item);
    }
  }
  return hrefs;
}
