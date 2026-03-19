#!/usr/bin/env node
/**
 * Scan WarcraftModels/ for *.mdx files
 * Convert each MDX to GLB for browser viewing (with BLP textures, UVs, skeleton, and animations)
 * Write manifest.json with model list
 */
import fs from 'fs';
import path from 'path';
import { mat4, quat, vec3 } from 'gl-matrix';
import { parseMDX, decodeBLP, getBLPImageData } from 'war3-model';
import UPNG from 'upng-js';
