import type { Request, Response } from 'express';
import * as productService from './product.service.js';
import {
  createProductSchema,
  listProductsSchema,
  updateProductSchema,
} from './product.validation.js';
import { ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export async function create(req: Request, res: Response) {
  ok(res, await productService.createProduct(createProductSchema.parse(req.body), req.user!), 201);
}

export async function list(req: Request, res: Response) {
  ok(res, await productService.listProducts(listProductsSchema.parse(req.query), req.user!));
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await productService.getProductById(req.params.id, req.user!));
}

export async function update(req: Request<IdParams>, res: Response) {
  const input = updateProductSchema.parse(req.body);
  ok(res, await productService.updateProduct(req.params.id, input, req.user!));
}
