import { createHandler } from './handler.mjs';
import { readTrip, writeTrip } from './repository.mjs';
import { readImage, storeImage } from './images.mjs';

export default createHandler({ readTrip, writeTrip, readImage, storeImage });
export const config = { path: '/api/*' };
