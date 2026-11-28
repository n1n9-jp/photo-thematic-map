/** 配色（`palette.ts`）の光を作る。太陽の位置は呼び出し側が決める。 */
import { AmbientLight, DirectionalLight, HemisphereLight } from 'three';
import type { CityLights } from './palette';

export interface PaletteLights {
  hemisphere: HemisphereLight;
  ambient: AmbientLight;
  sun: DirectionalLight;
}

export function createPaletteLights(l: CityLights): PaletteLights {
  return {
    hemisphere: new HemisphereLight(l.hemisphereSky, l.hemisphereGround, l.hemisphereIntensity),
    ambient: new AmbientLight(l.ambient, l.ambientIntensity),
    sun: new DirectionalLight(l.sun, l.sunIntensity),
  };
}
