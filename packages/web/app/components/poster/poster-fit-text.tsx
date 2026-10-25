'use client';

// A printed name that steps its size down until it fits its line budget, then
// clamps with an ellipsis (#4415).
//
// A Spraywall's name can run to 200 characters, and a poster has room for two
// or three lines of it. Counting characters guesses; measuring knows — a name of
// "W"s and a name of "i"s of the same length wrap very differently. So the
// server picks a first step from the length (what prints if JavaScript never
// runs), and this island measures the real line count and settles on the
// largest step that fits, before the page is printed.
//
// The steps themselves (size, leading, tracking, clamp) live in the caller's
// stylesheet as `[data-fit-step='N']` rules; this component only knows each
// step's line budget and moves the attribute.

import React, { useLayoutEffect, useRef } from 'react';
import styles from './poster-fit-text.module.css';

type PosterFitTextProps = {
  text: string;
  className?: string;
  /** How many lines each step may take, largest type first. The last step clamps. */
  lineBudgets: readonly number[];
  /** The step the server guessed from the text's length; what prints without JavaScript. */
  initialStep: number;
  as?: 'h1' | 'h2';
};

/** Distinct line boxes the element's text occupies, read off the rendered layout. */
function countRenderedLines(element: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  // jsdom implements no layout; a renderer without rects reads as one line.
  if (typeof range.getClientRects !== 'function') return 1;
  const lineTops = new Set<number>();
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0) lineTops.add(Math.round(rect.top));
  }
  return lineTops.size;
}

/** Set the largest step whose line count is within its budget, else the last (clamped) step. */
function fitToBudget(element: HTMLElement, lineBudgets: readonly number[]): void {
  element.setAttribute('data-fit-measuring', '');
  let chosenStep = lineBudgets.length - 1;
  for (let step = 0; step < lineBudgets.length; step += 1) {
    element.setAttribute('data-fit-step', String(step));
    if (countRenderedLines(element) <= lineBudgets[step]) {
      chosenStep = step;
      break;
    }
  }
  element.setAttribute('data-fit-step', String(chosenStep));
  element.removeAttribute('data-fit-measuring');
}

export default function PosterFitText({ text, className, lineBudgets, initialStep, as = 'h1' }: PosterFitTextProps) {
  const elementRef = useRef<HTMLHeadingElement>(null);
  // A string key, so a fresh array with the same budgets does not refit.
  const budgetKey = lineBudgets.join(',');

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const budgets = budgetKey.split(',').map(Number);
    const fit = () => fitToBudget(element, budgets);
    fit();
    // A web font (or a slow system font fallback) can land after first layout
    // and change every line break; measure again once fonts settle, and once
    // more as the print dialog opens.
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });
    window.addEventListener('beforeprint', fit);
    return () => {
      cancelled = true;
      window.removeEventListener('beforeprint', fit);
    };
  }, [budgetKey, text]);

  const Heading = as;
  const classNames = [styles.fitText, className].filter(Boolean).join(' ');
  return (
    <Heading ref={elementRef} className={classNames} data-fit-step={initialStep}>
      {text}
    </Heading>
  );
}
