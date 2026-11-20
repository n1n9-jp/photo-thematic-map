import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GROUND_SIZE_M, REFERENCE_BOX_SIZE_M } from '../config';

export interface SceneContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  /** 1フレーム描画する。 */
  render(): void;
  dispose(): void;
}

const SKY_COLOR = 0x9ec9ee;

/** 最小シーン（空・光・地面・基準箱・OrbitControls）を構築する。 */
export function createScene(container: HTMLElement): SceneContext {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(SKY_COLOR);
  scene.fog = new Fog(SKY_COLOR, 800, 3000);

  const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 20000);
  camera.position.set(40, 30, 50);

  scene.add(new HemisphereLight(0xdcecff, 0x6b6558, 0.6));
  scene.add(new AmbientLight(0xffffff, 0.4));
  const sun = new DirectionalLight(0xffffff, 2.0);
  sun.position.set(-200, 400, 150);
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(GROUND_SIZE_M, GROUND_SIZE_M),
    new MeshStandardMaterial({ color: 0x7c8a6a, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const box = new Mesh(
    new BoxGeometry(REFERENCE_BOX_SIZE_M, REFERENCE_BOX_SIZE_M, REFERENCE_BOX_SIZE_M),
    new MeshStandardMaterial({ color: 0xe0533d, roughness: 0.6 }),
  );
  box.position.y = REFERENCE_BOX_SIZE_M / 2;
  scene.add(box);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, REFERENCE_BOX_SIZE_M / 2, 0);
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.update();

  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const render = (): void => {
    controls.update();
    renderer.render(scene, camera);
  };

  const dispose = (): void => {
    window.removeEventListener('resize', onResize);
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };

  return { renderer, scene, camera, controls, render, dispose };
}
