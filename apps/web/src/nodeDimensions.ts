export interface CanvasNodeDimensions {
  width: number;
  height: number;
  minimizedWidth: number;
  minimizedHeight: number;
}

export const TURN_NODE_DIMENSIONS = {
  width: 400,
  height: 320,
  minimizedWidth: 68,
  minimizedHeight: 48,
} as const satisfies CanvasNodeDimensions;

export const FILE_NODE_DIMENSIONS = {
  width: 320,
  height: 260,
  minimizedWidth: 68,
  minimizedHeight: 48,
} as const satisfies CanvasNodeDimensions;

export const PROMPT_NODE_DIMENSIONS = {
  width: 340,
  height: 280,
  minimizedWidth: 68,
  minimizedHeight: 48,
} as const satisfies CanvasNodeDimensions;

export const COMMIT_NODE_DIMENSIONS = {
  width: 300,
  height: 190,
  minimizedWidth: 76,
  minimizedHeight: 50,
} as const satisfies CanvasNodeDimensions;

export const PULL_REQUEST_NODE_DIMENSIONS = {
  width: 320,
  height: 200,
  minimizedWidth: 76,
  minimizedHeight: 50,
} as const satisfies CanvasNodeDimensions;

export const SYNC_FLOW_NODE_DIMENSIONS = {
  width: 320,
  height: 200,
  minimizedWidth: 76,
  minimizedHeight: 50,
} as const satisfies CanvasNodeDimensions;
