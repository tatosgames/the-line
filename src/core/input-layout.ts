import { fitArea } from './neon';
import type { Game } from '../game/game';

/** In portrait, centre the taller crop and keep the space below it for gestures. */
export function fitGameArea(width: number, height: number) {
  const area = fitArea(width, height);
  if (height > width) {
    area.h *= 1.15;
    area.y = Math.round((height - area.h) / 2);
  }
  return area;
}

export function bindGameInputLayout(game: Game) {
  game.input.gestureTop = () => {
    const { neon } = game;
    return game.mode === 'play' && neon.fullH > neon.fullW ? neon.oy + neon.h : 0;
  };
}
