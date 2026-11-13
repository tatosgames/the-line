/** Keep path commands portable so Canvas and Pixi can draw the same geometry. */
type Command =
  | ['moveTo' | 'lineTo', number, number]
  | ['quadraticCurveTo' | 'rect', number, number, number, number]
  | ['arc', number, number, number, number, number, boolean]
  | ['ellipse', number, number, number, number, number, number, number, boolean]
  | ['closePath'];

export class RenderPath {
  readonly commands: Command[] = [];
  private native?: Path2D;

  moveTo(x: number, y: number) { this.commands.push(['moveTo', x, y]); }
  lineTo(x: number, y: number) { this.commands.push(['lineTo', x, y]); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) { this.commands.push(['quadraticCurveTo', cx, cy, x, y]); }
  rect(x: number, y: number, w: number, h: number) { this.commands.push(['rect', x, y, w, h]); }
  arc(x: number, y: number, r: number, start: number, end: number, ccw = false) { this.commands.push(['arc', x, y, r, start, end, ccw]); }
  ellipse(x: number, y: number, rx: number, ry: number, angle: number, start: number, end: number, ccw = false) {
    this.commands.push(['ellipse', x, y, rx, ry, angle, start, end, ccw]);
  }
  closePath() { this.commands.push(['closePath']); }

  canvasPath() {
    if (this.native) return this.native;
    const path = new Path2D();
    for (const command of this.commands) {
      switch (command[0]) {
        case 'moveTo': path.moveTo(command[1], command[2]); break;
        case 'lineTo': path.lineTo(command[1], command[2]); break;
        case 'quadraticCurveTo': path.quadraticCurveTo(command[1], command[2], command[3], command[4]); break;
        case 'rect': path.rect(command[1], command[2], command[3], command[4]); break;
        case 'arc': path.arc(command[1], command[2], command[3], command[4], command[5], command[6]); break;
        case 'ellipse': path.ellipse(command[1], command[2], command[3], command[4], command[5], command[6], command[7], command[8]); break;
        case 'closePath': path.closePath(); break;
      }
    }
    this.native = path;
    return path;
  }
}
