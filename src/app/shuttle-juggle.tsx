import type { CSSProperties } from "react";
import ShuttleArt from "./shuttle-art";

// Vertical flight with quadratic air drag: dv/dt = -g - v|v|/L.
// L = 4.6 m follows Cohen et al., "The physics of badminton" (2015).
const gravity = 9.81;
const dragLength = 4.6;
const launchSpeed = 3.2;
const restitution = 0.82;
const pixelsPerMeter = 300;
const terminalSpeed = Math.sqrt(gravity * dragLength);
const launchAngle = Math.atan(launchSpeed / terminalSpeed);
const ascentTime = terminalSpeed * launchAngle / gravity;
const descentTime = terminalSpeed * Math.asinh(launchSpeed / terminalSpeed) / gravity;
const duration = ascentTime + descentTime;
const apexHeight = dragLength * Math.log1p((launchSpeed / terminalSpeed) ** 2) / 2;
const incomingSpeed = terminalSpeed * Math.tanh(gravity * descentTime / terminalSpeed);

// The rising racket supplies the energy lost to drag and the impact.
// vAfter = (1 + e) * vRacket - e * vBefore, with upward velocity positive.
const tapSpeed = (launchSpeed - restitution * incomingSpeed) / (1 + restitution);
const racketAmplitude = tapSpeed * pixelsPerMeter * duration / (2 * Math.PI);

export const jugglePhysics = {
  gravity, dragLength, launchSpeed, restitution, pixelsPerMeter,
  duration, ascentTime, apexHeight, incomingSpeed, tapSpeed, racketAmplitude,
  contactX: 95,
  contactY: 225,
  shuttleScale: 0.34,
};

export function sampleJuggle(time: number) {
  const t = Math.max(0, Math.min(duration, time));
  const rising = t <= ascentTime;
  const argument = rising ? launchAngle - gravity * t / terminalSpeed : gravity * (t - ascentTime) / terminalSpeed;
  const height = Math.max(0, rising
    ? dragLength * Math.log(Math.cos(argument) / Math.cos(launchAngle))
    : apexHeight - dragLength * Math.log(Math.cosh(argument)));
  const velocity = rising ? terminalSpeed * Math.tan(argument) : -terminalSpeed * Math.tanh(argument);
  const phase = 2 * Math.PI * t / duration;
  return {
    height,
    velocity,
    racketOffset: -racketAmplitude * Math.sin(phase),
    racketVelocity: -tapSpeed * pixelsPerMeter * Math.cos(phase),
  };
}

const impactTurnTime = 0.05;
const apexTurnStart = ascentTime - 0.025;
const apexTurnEnd = ascentTime + 0.025;

export function sampleShuttleOrientation(time: number) {
  const turn = (start: number, length: number, from: number) => {
    const progress = Math.max(0, Math.min(1, (time - start) / length));
    return {
      position: from + 180 * progress ** 2 * (3 - 2 * progress),
      velocity: 180 * 6 * progress * (1 - progress) / length,
    };
  };
  if (time < impactTurnTime) return turn(0, impactTurnTime, 0);
  if (time < apexTurnStart) return { position: 180, velocity: 0 };
  if (time < apexTurnEnd) return turn(apexTurnStart, apexTurnEnd - apexTurnStart, 180);
  return { position: 360, velocity: 0 };
}

// Include the exact apex and racket turnarounds. Cubic Hermite interpolation
// preserves endpoint velocities, including zero speed at the apex.
const times = [...new Set([
  ...Array.from({ length: 49 }, (_, index) => index * duration / 48),
  ascentTime,
  impactTurnTime,
  apexTurnStart,
  apexTurnEnd,
])].sort((a, b) => a - b);

type MotionValue = { position: number; velocity: number };
const number = (value: number) => Number(value.toFixed(6));

function keyframes(name: string, sample: (time: number) => MotionValue, transform: (position: number) => string) {
  return `@keyframes ${name} {\n${times.map((time, index) => {
    const current = sample(time);
    const nextTime = times[index + 1];
    let easing = "linear";
    if (nextTime !== undefined) {
      const next = sample(nextTime);
      const delta = next.position - current.position;
      if (Math.abs(delta) > 1e-9) {
        const interval = nextTime - time;
        easing = `cubic-bezier(.333333,${number(current.velocity * interval / (3 * delta))},.666667,${number(1 - next.velocity * interval / (3 * delta))})`;
      }
    }
    return `${number(time / duration * 100)}% { transform: ${transform(current.position)}; animation-timing-function: ${easing}; }`;
  }).join("\n")}\n}`;
}

const animationStyles = [
  keyframes("serve-juggle-flight", (time) => {
    const motion = sampleJuggle(time);
    return { position: -motion.height * pixelsPerMeter, velocity: -motion.velocity * pixelsPerMeter };
  }, (position) => `translateY(${number(position)}px)`),
  keyframes("serve-juggle-tap", (time) => {
    const motion = sampleJuggle(time);
    return { position: motion.racketOffset, velocity: motion.racketVelocity };
  }, (position) => `translateY(${number(position)}px)`),
  keyframes("serve-juggle-turn", sampleShuttleOrientation, (position) => `rotate(${number(position)}deg)`),
].join("\n");

export default function ShuttleJuggle({ compact = false }: { compact?: boolean }) {
  const { contactX, contactY, shuttleScale } = jugglePhysics;
  return (
    <svg
      className="serve-juggle"
      viewBox={compact ? "40 48 190 200" : "0 0 320 280"}
      fill="none"
      focusable="false"
      style={{ "--serve-juggle-duration": `${duration}s` } as CSSProperties}
    >
      <style>{animationStyles}</style>
      <g className="serve-juggle__racket" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M135 229l68 21" strokeWidth="2.2" />
        <path d="M203 250l40 12" strokeWidth="7.5" />
        <path d="m209 248-2 6m10-3-2 6m10-4-2 6m10-4-2 6m10-4-2 6" stroke="#d5f168" strokeWidth="1.2" />
        <ellipse cx="95" cy="225" rx="42" ry="13" fill="#d5f168" strokeWidth="2.2" />
        <ellipse cx="95" cy="225" rx="39" ry="10.5" fill="#f8fcf7" strokeWidth=".8" />
        <path d="M64 219h62M58 222h74M56 225h78M58 228h74M64 231h62M65 219v12M75 216.5v17M85 215v20M95 214.5v21M105 215v20M115 216.5v17M125 219v12" strokeWidth=".6" opacity=".4" />
      </g>
      <g className="serve-juggle__flight">
        {/* Rotate about the cork's mass centre, keeping the flight path continuous. */}
        <g transform={`translate(${contactX} ${contactY - 8 * shuttleScale}) scale(${shuttleScale})`}>
          <g className="serve-juggle__attitude">
            <g transform="translate(-32 -68)">
              <ShuttleArt />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
