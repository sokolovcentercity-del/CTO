/*
 * Same-origin PDF.js worker bridge.
 * The browser loads this file as a regular Worker, so PDF.js does not need
 * to create a blob: wrapper for the cross-origin CDN worker.
 */
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js');
