import { createApp } from './app.js';

declare function acquireVsCodeApi(): import('../protocol.js').VsCodeApi;

createApp(acquireVsCodeApi());
