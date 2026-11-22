/**
 * 地面に貼る航空写真の出典。既定は PLATEAU-Ortho。URL に `?ortho=gsi` を付けると、国土地理院の
 * 「全国最新写真（シームレス）」に切り替える（転送量と見た目の比較用）。
 */
import { GSI_PHOTO_MAX_ZOOM, GSI_PHOTO_URL, PLATEAU_ORTHO_MAX_ZOOM, PLATEAU_ORTHO_URL } from '../../config';

export type OrthoSource = 'plateau' | 'gsi';

export interface OrthoSourceInfo {
  /** XYZ タイルの URL のひな形（{z}/{x}/{y}）。 */
  url: string;
  maxZoom: number;
}

export const ORTHO_SOURCES: Record<OrthoSource, OrthoSourceInfo> = {
  plateau: { url: PLATEAU_ORTHO_URL, maxZoom: PLATEAU_ORTHO_MAX_ZOOM },
  gsi: { url: GSI_PHOTO_URL, maxZoom: GSI_PHOTO_MAX_ZOOM },
};

/** URL のクエリ `ortho` から出典を選ぶ。 */
export function orthoSourceFromUrl(search: string = typeof location === 'undefined' ? '' : location.search): OrthoSource {
  return new URLSearchParams(search).get('ortho') === 'gsi' ? 'gsi' : 'plateau';
}

export function orthoTileUrl(source: OrthoSource, z: number, x: number, y: number): string {
  return ORTHO_SOURCES[source].url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
