import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { MathPlot3DSpec, Sampled3DPlot } from './mathPlotSpec';
import { samplePlot3D } from './mathPlotSpec';

interface MathPlot3DProps {
  spec: MathPlot3DSpec;
  /** Render without the bordered card / header chrome (used inside the plot modal). */
  variant?: 'inline' | 'modal';
  /** Notify when the plot area is shift-clicked (used to open the modal). */
  onShiftClick?: () => void;
}

const INITIAL_VIEW = { yaw: -0.72, pitch: 0.52, distance: 7.1 };

function normalize(value: number, min: number, max: number, size = 4) {
  if (min === max) return 0;
  return ((value - min) / (max - min) - 0.5) * size;
}

function buildSurfaceGeometry(THREE: typeof import('three'), sampled: Sampled3DPlot) {
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexIndexes = new Map<string, number>();
  const { spec } = sampled;

  for (let yIndex = 0; yIndex < sampled.rows.length; yIndex += 1) {
    const row = sampled.rows[yIndex];
    for (let xIndex = 0; xIndex < row.length; xIndex += 1) {
      const point = row[xIndex];
      if (!point) continue;
      const vertexIndex = positions.length / 3;
      vertexIndexes.set(`${xIndex}:${yIndex}`, vertexIndex);
      positions.push(
        normalize(point.x, spec.x.min, spec.x.max),
        normalize(point.z, sampled.zDomain.min, sampled.zDomain.max, 2.6),
        normalize(point.y, spec.y.min, spec.y.max),
      );
    }
  }

  for (let yIndex = 0; yIndex < sampled.rows.length - 1; yIndex += 1) {
    for (let xIndex = 0; xIndex < sampled.rows[yIndex].length - 1; xIndex += 1) {
      const a = vertexIndexes.get(`${xIndex}:${yIndex}`);
      const b = vertexIndexes.get(`${xIndex + 1}:${yIndex}`);
      const c = vertexIndexes.get(`${xIndex}:${yIndex + 1}`);
      const d = vertexIndexes.get(`${xIndex + 1}:${yIndex + 1}`);
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildAxes(THREE: typeof import('three')) {
  const axis = 2.25;
  const positions = [-axis, 0, 0, axis, 0, 0, 0, -1.45, 0, 0, 1.45, 0, 0, 0, -axis, 0, 0, axis];
  const colors = [
    0.95, 0.24, 0.35, 0.95, 0.24, 0.35, 0.36, 0.75, 0.48, 0.36, 0.75, 0.48, 0.24, 0.52, 0.95, 0.24,
    0.52, 0.95,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
  });
  return new THREE.LineSegments(geometry, material);
}

export function MathPlot3D({ spec, variant = 'inline', onShiftClick }: MathPlot3DProps) {
  const isModal = variant === 'modal';
  const plotHeight = isModal ? 540 : 320;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline plots are user-resizable via the drag bar below the canvas. The live
  // renderer follows this height through its ResizeObserver, so we never rebuild
  // the scene on resize.
  const [areaHeight, setAreaHeight] = useState(plotHeight);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleResizePointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = { startY: event.clientY, startHeight: areaHeight };
  };
  const handleResizePointerMove = (event: ReactPointerEvent) => {
    const state = dragStateRef.current;
    if (!state) return;
    const next = Math.max(180, Math.min(900, state.startHeight + (event.clientY - state.startY)));
    setAreaHeight(next);
  };
  const handleResizePointerUp = (event: ReactPointerEvent) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    setError(null);

    async function renderPlot() {
      try {
        const sampled = samplePlot3D(spec);
        const THREE = await import('three');
        if (disposed || !mountRef.current) return;

        const mount = mountRef.current;
        const width = Math.max(320, Math.floor(mount.clientWidth || 560));
        const height = Math.max(180, Math.floor(mount.clientHeight || plotHeight));
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.touchAction = 'none';
        mount.replaceChildren(renderer.domElement);

        const surfaceGeometry = buildSurfaceGeometry(THREE, sampled);
        const surfaceMaterial = new THREE.MeshStandardMaterial({
          color: 0x8b5cf6,
          metalness: 0.05,
          roughness: 0.72,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
        });
        const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
        scene.add(surface);

        const wireGeometry = surfaceGeometry.clone();
        const wireMaterial = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          wireframe: true,
          transparent: true,
          opacity: 0.1,
        });
        const wire = new THREE.Mesh(wireGeometry, wireMaterial);
        scene.add(wire);

        const axes = buildAxes(THREE);
        scene.add(axes);
        scene.add(new THREE.AmbientLight(0xffffff, 1.7));
        const light = new THREE.DirectionalLight(0xffffff, 1.9);
        light.position.set(3, 5, 4);
        scene.add(light);

        let yaw = INITIAL_VIEW.yaw;
        let pitch = INITIAL_VIEW.pitch;
        let distance = INITIAL_VIEW.distance;
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let frame = 0;

        const updateCamera = () => {
          const clampedPitch = Math.max(-1.15, Math.min(1.15, pitch));
          pitch = clampedPitch;
          camera.position.set(
            Math.sin(yaw) * Math.cos(pitch) * distance,
            Math.sin(pitch) * distance,
            Math.cos(yaw) * Math.cos(pitch) * distance,
          );
          camera.lookAt(0, 0, 0);
        };

        const onPointerDown = (event: PointerEvent) => {
          dragging = true;
          lastX = event.clientX;
          lastY = event.clientY;
          renderer.domElement.setPointerCapture(event.pointerId);
        };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          const dx = event.clientX - lastX;
          const dy = event.clientY - lastY;
          lastX = event.clientX;
          lastY = event.clientY;
          yaw -= dx * 0.008;
          pitch += dy * 0.008;
          updateCamera();
        };
        const onPointerUp = (event: PointerEvent) => {
          dragging = false;
          if (renderer.domElement.hasPointerCapture(event.pointerId)) {
            renderer.domElement.releasePointerCapture(event.pointerId);
          }
        };
        const onWheel = (event: WheelEvent) => {
          event.preventDefault();
          distance = Math.max(3.4, Math.min(12, distance + event.deltaY * 0.006));
          updateCamera();
        };
        // Follow the (possibly user-resized) mount in both dimensions so dragging
        // the resize handle actually gives the surface more room.
        const applySize = () => {
          const nextWidth = Math.max(320, Math.floor(mount.clientWidth || 560));
          const nextHeight = Math.max(180, Math.floor(mount.clientHeight || plotHeight));
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(nextWidth, nextHeight);
        };
        const resizeObserver = new ResizeObserver(applySize);
        resizeObserver.observe(mount);

        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        renderer.domElement.addEventListener('pointercancel', onPointerUp);
        renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

        const animate = () => {
          if (disposed) return;
          frame = window.requestAnimationFrame(animate);
          renderer.render(scene, camera);
        };

        // Expose a reset that returns the camera to its initial framing.
        resetRef.current = () => {
          yaw = INITIAL_VIEW.yaw;
          pitch = INITIAL_VIEW.pitch;
          distance = INITIAL_VIEW.distance;
          updateCamera();
        };

        updateCamera();
        animate();
        setError(null);

        cleanup = () => {
          resetRef.current = null;
          window.cancelAnimationFrame(frame);
          resizeObserver.disconnect();
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          renderer.domElement.removeEventListener('pointermove', onPointerMove);
          renderer.domElement.removeEventListener('pointerup', onPointerUp);
          renderer.domElement.removeEventListener('pointercancel', onPointerUp);
          renderer.domElement.removeEventListener('wheel', onWheel);
          surfaceGeometry.dispose();
          surfaceMaterial.dispose();
          wireGeometry.dispose();
          wireMaterial.dispose();
          (axes.geometry as import('three').BufferGeometry).dispose();
          (axes.material as import('three').Material).dispose();
          renderer.dispose();
          mount.replaceChildren();
        };
      } catch (err) {
        if (!disposed) setError(String(err instanceof Error ? err.message : err));
      }
    }

    void renderPlot();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [spec, plotHeight]);

  const handleClick = onShiftClick
    ? (event: ReactMouseEvent) => {
        if (event.shiftKey) {
          event.preventDefault();
          onShiftClick();
        }
      }
    : undefined;

  return (
    <div
      className={isModal ? '' : 'rounded-lg border border-border/45 bg-background/45 p-3'}
      onClick={handleClick}
      title={onShiftClick ? 'Shift-click to open the interactive plot editor' : undefined}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        {!isModal && <span className="font-medium text-foreground/85">3D plot</span>}
        <div className={`flex min-w-0 items-center gap-2 ${isModal ? 'ml-auto' : ''}`}>
          {!isModal && <span className="truncate font-mono">z = {spec.expression}</span>}
          {!error && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                resetRef.current?.();
              }}
              className="shrink-0 rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-border/80 hover:text-foreground"
              title="Reset the camera to its default angle"
            >
              Reset view
            </button>
          )}
        </div>
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          Could not render 3D plot: {error}
        </div>
      ) : (
        <>
          <div
            ref={mountRef}
            className="w-full overflow-hidden rounded-md bg-muted/15"
            style={{ height: isModal ? plotHeight : areaHeight }}
          />
          {!isModal && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize plot height"
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onPointerCancel={handleResizePointerUp}
              className="group mt-1 flex h-3 w-full cursor-row-resize items-center justify-center rounded-sm hover:bg-muted/40"
              title="Drag to resize the plot height"
            >
              <span className="h-0.5 w-8 rounded-full bg-border/70 transition-colors group-hover:bg-foreground/40" />
            </div>
          )}
          <p className="mt-1 text-center text-[10px] text-muted-foreground/70">
            Drag to rotate · scroll to zoom
          </p>
        </>
      )}
    </div>
  );
}
