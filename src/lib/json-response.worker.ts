import { prepareJsonDocument } from './json-document';

self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(prepareJsonDocument(event.data));
};
