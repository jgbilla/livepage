// Livepage icon set: a fixed, curated subset of Lucide (https://lucide.dev, ISC license, see below),
// inlined so the app ships only the icons it uses and has no icon dependency.
// Every icon is drawn on a 24px grid with a 1.75px round stroke and inherits currentColor.
// To add one: copy its nodes from lucide.dev ("Copy JSX") into ICONS, keep the name short and generic.
//
// Lucide ISC License: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
// Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use,
// copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
// provided that the above copyright notice and this permission notice appear in all copies.
import { createElement, type CSSProperties } from 'react';

type Node = [string, Record<string, string | number>];
const ICONS = {
  'menu': [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],
  'search': [["circle",{"cx":"11","cy":"11","r":"8"}],["path",{"d":"m21 21-4.3-4.3"}]],
  'tasks': [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 7v7"}],["path",{"d":"M12 7v4"}],["path",{"d":"M16 7v9"}]],
  'graph': [["circle",{"cx":"12","cy":"4.5","r":"2.5"}],["path",{"d":"m10.2 6.3-3.9 3.9"}],["circle",{"cx":"4.5","cy":"12","r":"2.5"}],["path",{"d":"M7 12h10"}],["circle",{"cx":"19.5","cy":"12","r":"2.5"}],["path",{"d":"m13.8 17.7 3.9-3.9"}],["circle",{"cx":"12","cy":"19.5","r":"2.5"}]],
  'today': [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m17.66 17.66 1.41 1.41"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"m6.34 17.66-1.41 1.41"}],["path",{"d":"m19.07 4.93-1.41 1.41"}]],
  'plus': [["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],
  'folder': [["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],
  'folder-open': [["path",{"d":"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"}]],
  'folder-plus': [["path",{"d":"M12 10v6"}],["path",{"d":"M9 13h6"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]],
  'file': [["path",{"d":"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"}],["path",{"d":"M14 2v4a2 2 0 0 0 2 2h4"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]],
  'chevron-right': [["path",{"d":"m9 18 6-6-6-6"}]],
  'chevron-down': [["path",{"d":"m6 9 6 6 6-6"}]],
  'pencil': [["path",{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"}],["path",{"d":"m15 5 4 4"}]],
  'x': [["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],
  'trash': [["path",{"d":"M3 6h18"}],["path",{"d":"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"}],["path",{"d":"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"}],["line",{"x1":"10","x2":"10","y1":"11","y2":"17"}],["line",{"x1":"14","x2":"14","y1":"11","y2":"17"}]],
  'link': [["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],
  'history': [["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M12 7v5l4 2"}]],
  'copy': [["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],
  'check': [["path",{"d":"M20 6 9 17l-5-5"}]],
  'download': [["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["polyline",{"points":"7 10 12 15 17 10"}],["line",{"x1":"12","x2":"12","y1":"15","y2":"3"}]],
  'printer': [["path",{"d":"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"}],["path",{"d":"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"}],["rect",{"x":"6","y":"14","width":"12","height":"8","rx":"1"}]],
  'globe': [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]],
  'sparkles': [["path",{"d":"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"}],["path",{"d":"M20 3v4"}],["path",{"d":"M22 5h-4"}],["path",{"d":"M4 17v2"}],["path",{"d":"M5 18H3"}]],
  'comment': [["path",{"d":"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"}]],
  'more': [["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]],
  'arrow-up-right': [["path",{"d":"M7 7h10v10"}],["path",{"d":"M7 17 17 7"}]],
  'arrow-right-to-line': [["path",{"d":"M17 12H3"}],["path",{"d":"m11 18 6-6-6-6"}],["path",{"d":"M21 5v14"}]],
  'corner-up-left': [["polyline",{"points":"9 14 4 9 9 4"}],["path",{"d":"M20 20v-7a4 4 0 0 0-4-4H4"}]],
  'arrow-down': [["path",{"d":"M12 5v14"}],["path",{"d":"m19 12-7 7-7-7"}]],
  'view': [["rect",{"width":"7","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"7","x":"3","y":"14","rx":"1"}],["path",{"d":"M14 4h7"}],["path",{"d":"M14 9h7"}],["path",{"d":"M14 15h7"}],["path",{"d":"M14 20h7"}]],
  'import-export': [["path",{"d":"m3 16 4 4 4-4"}],["path",{"d":"M7 20V4"}],["path",{"d":"m21 8-4-4-4 4"}],["path",{"d":"M17 4v16"}]],
  'hash': [["line",{"x1":"4","x2":"20","y1":"9","y2":"9"}],["line",{"x1":"4","x2":"20","y1":"15","y2":"15"}],["line",{"x1":"10","x2":"8","y1":"3","y2":"21"}],["line",{"x1":"16","x2":"14","y1":"3","y2":"21"}]],
  'alert': [["path",{"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}],["path",{"d":"M12 9v4"}],["path",{"d":"M12 17h.01"}]],
  'loader': [["path",{"d":"M21 12a9 9 0 1 1-6.219-8.56"}]],
  'log-out': [["path",{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"}],["polyline",{"points":"16 17 21 12 16 7"}],["line",{"x1":"21","x2":"9","y1":"12","y2":"12"}]],
  'settings': [["path",{"d":"M20 7h-9"}],["path",{"d":"M14 17H5"}],["circle",{"cx":"17","cy":"17","r":"3"}],["circle",{"cx":"7","cy":"7","r":"3"}]],
  'moon': [["path",{"d":"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"}]],
  'sun': [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 3v1"}],["path",{"d":"M12 20v1"}],["path",{"d":"M3 12h1"}],["path",{"d":"M20 12h1"}],["path",{"d":"m18.364 5.636-.707.707"}],["path",{"d":"m6.343 17.657-.707.707"}],["path",{"d":"m5.636 5.636.707.707"}],["path",{"d":"m17.657 17.657.707.707"}]],
  'monitor': [["rect",{"width":"20","height":"14","x":"2","y":"3","rx":"2"}],["line",{"x1":"8","x2":"16","y1":"21","y2":"21"}],["line",{"x1":"12","x2":"12","y1":"17","y2":"21"}]],
  'key': [["path",{"d":"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"}],["circle",{"cx":"16.5","cy":"7.5","r":".5","fill":"currentColor"}]],
  'users': [["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["circle",{"cx":"9","cy":"7","r":"4"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["path",{"d":"M16 3.13a4 4 0 0 1 0 7.75"}]],
  'bold': [["path",{"d":"M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"}]],
  'italic': [["line",{"x1":"19","x2":"10","y1":"4","y2":"4"}],["line",{"x1":"14","x2":"5","y1":"20","y2":"20"}],["line",{"x1":"15","x2":"9","y1":"4","y2":"20"}]],
  'list': [["path",{"d":"M3 12h.01"}],["path",{"d":"M3 18h.01"}],["path",{"d":"M3 6h.01"}],["path",{"d":"M8 12h13"}],["path",{"d":"M8 18h13"}],["path",{"d":"M8 6h13"}]],
  'heading': [["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"}]],
  'code': [["polyline",{"points":"16 18 22 12 16 6"}],["polyline",{"points":"8 6 2 12 8 18"}]],
  'table': [["path",{"d":"M12 3v18"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M3 15h18"}]],
  'mind-map': [["rect",{"x":"16","y":"16","width":"6","height":"6","rx":"1"}],["rect",{"x":"2","y":"16","width":"6","height":"6","rx":"1"}],["rect",{"x":"9","y":"2","width":"6","height":"6","rx":"1"}],["path",{"d":"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"}],["path",{"d":"M12 12V8"}]],
  'html-block': [["path",{"d":"m18 16 4-4-4-4"}],["path",{"d":"m6 8-4 4 4 4"}],["path",{"d":"m14.5 4-5 16"}]],
  'footnote': [["path",{"d":"m4 19 8-8"}],["path",{"d":"m12 19-8-8"}],["path",{"d":"M20 12h-4c0-1.5.442-2 1.5-2.5S20 8.334 20 7.002c0-.472-.17-.93-.484-1.29a2.105 2.105 0 0 0-2.617-.436c-.42.239-.738.614-.899 1.06"}]],
  'send': [["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]],
  'refresh': [["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]],
  'restore': [["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}]],
  'eye': [["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
  'circle-check': [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]],
  'reply': [["polyline",{"points":"9 17 4 12 9 7"}],["path",{"d":"M20 18v-2a4 4 0 0 0-4-4H4"}]],
  'lock': [["rect",{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"}],["path",{"d":"M7 11V7a5 5 0 0 1 10 0v4"}]],
  'external': [["path",{"d":"M15 3h6v6"}],["path",{"d":"M10 14 21 3"}],["path",{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]],
  'template': [["rect",{"width":"18","height":"7","x":"3","y":"3","rx":"1"}],["rect",{"width":"9","height":"7","x":"3","y":"14","rx":"1"}],["rect",{"width":"5","height":"7","x":"16","y":"14","rx":"1"}]],
  'circle': [["circle",{"cx":"12","cy":"12","r":"10"}]],
  'text': [["polyline",{"points":"4 7 4 4 20 4 20 7"}],["line",{"x1":"9","x2":"15","y1":"20","y2":"20"}],["line",{"x1":"12","x2":"12","y1":"4","y2":"20"}]],
  'heading-1': [["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"m17 12 3-2v8"}]],
  'heading-3': [["path",{"d":"M4 12h8"}],["path",{"d":"M4 18V6"}],["path",{"d":"M12 18V6"}],["path",{"d":"M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"}],["path",{"d":"M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"}]],
  'list-ordered': [["path",{"d":"M10 12h11"}],["path",{"d":"M10 18h11"}],["path",{"d":"M10 6h11"}],["path",{"d":"M4 10h2"}],["path",{"d":"M4 6h1v4"}],["path",{"d":"M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"}]],
  'todo': [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"m9 12 2 2 4-4"}]],
  'quote': [["path",{"d":"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"}],["path",{"d":"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"}]],
  'divider': [["path",{"d":"M5 12h14"}]],
  'strike': [["path",{"d":"M16 4H9a3 3 0 0 0-2.83 4"}],["path",{"d":"M14 12a4 4 0 0 1 0 8H6"}],["line",{"x1":"4","x2":"20","y1":"12","y2":"12"}]],
  'circle-dot': [["circle",{"cx":"12","cy":"12","r":"10"}],["circle",{"cx":"12","cy":"12","r":"1"}]],
  'at-sign': [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"}]],
  'ios-share': [["path",{"d":"M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"}],["polyline",{"points":"16 6 12 2 8 6"}],["line",{"x1":"12","x2":"12","y1":"2","y2":"15"}]],
  'square-plus': [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 12h8"}],["path",{"d":"M12 8v8"}]],
  'share': [["circle",{"cx":"18","cy":"5","r":"3"}],["circle",{"cx":"6","cy":"12","r":"3"}],["circle",{"cx":"18","cy":"19","r":"3"}],["line",{"x1":"8.59","x2":"15.42","y1":"13.51","y2":"17.49"}],["line",{"x1":"15.41","x2":"8.59","y1":"6.51","y2":"10.49"}]],
  'calendar': [["path",{"d":"M8 2v4"}],["path",{"d":"M16 2v4"}],["rect",{"width":"18","height":"18","x":"3","y":"4","rx":"2"}],["path",{"d":"M3 10h18"}],["path",{"d":"M8 14h.01"}],["path",{"d":"M12 14h.01"}],["path",{"d":"M16 14h.01"}],["path",{"d":"M8 18h.01"}],["path",{"d":"M12 18h.01"}],["path",{"d":"M16 18h.01"}]],
  'star': [["path",{"d":"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],
  'pin': [["path",{"d":"M12 17v5"}],["path",{"d":"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"}]],
  'tabs': [["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"2"}],["path",{"d":"M10 4v4"}],["path",{"d":"M2 8h20"}],["path",{"d":"M6 4v4"}]],
  'columns': [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M12 3v18"}]],
  'home': [["path",{"d":"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"}],["path",{"d":"M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}]],
} satisfies Record<string, Node[]>;

export type IconName = keyof typeof ICONS;

type Props = { name: IconName; size?: number; className?: string; style?: CSSProperties; strokeWidth?: number; label?: string };

/** One icon. Decorative by default (aria-hidden); pass `label` when the icon is the only content of a control. */
export function Icon({ name, size, className, style, strokeWidth = 1.75, label }: Props) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size ?? '1em'} height={size ?? '1em'} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style}
      aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}
    >
      {(ICONS[name] as Node[]).map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
