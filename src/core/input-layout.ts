import { fitArea } from './neon';
import type { Game } from '../game/game';

/** Reserve the area below the fixed 16:9 viewport for portrait touch gestures. */
export function fitGameArea(width: number, height: number) {
  const area = fitArea(width, height);
  if (height > width) area.y = Math.round(Math.min(24, (height - area.h) / 5));
  return area;
}

export function bindGameInputLayout(game: Game) {
  game.input.gestureTop = () => {
    const { neon } = game;
    return game.mode === 'play' && neon.fullH > neon.fullW ? neon.oy + neon.h : 0;
  };
}
