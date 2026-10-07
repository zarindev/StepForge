/** OpenAPI 3 description of the ShopDesk API (the documented contract; the planted bugs deviate from it). */
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const err = (description: string) => ({ description, ...json({ $ref: '#/components/schemas/Error' }) });

export const SHOP_OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'ShopDesk API',
    version: '1.0.0',
    description:
      'Demo shop back office: products, stock, sales, purchases and profit. Log in with POST /api/auth/login and send the token as a bearer token.',
  },
  servers: [{ url: 'http://127.0.0.1:8102' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Error: {
        type: 'object',
        required: ['error', 'message'],
        properties: { error: { type: 'string' }, message: { type: 'string' } },
      },
      Product: {
        type: 'object',
        required: ['id', 'sku', 'name', 'price', 'cost', 'stock'],
        properties: {
          id: { type: 'integer' },
          sku: { type: 'string', example: 'SKU-1001' },
          name: { type: 'string', example: 'Espresso beans 1 kg' },
          price: { type: 'number', example: 24 },
          cost: { type: 'number', example: 14 },
          stock: { type: 'integer', minimum: 0, example: 40 },
        },
      },
      NewProduct: {
        type: 'object',
        required: ['sku', 'name', 'price', 'cost'],
        properties: {
          sku: { type: 'string' },
          name: { type: 'string', minLength: 1 },
          price: { type: 'number', exclusiveMinimum: 0 },
          cost: { type: 'number', minimum: 0 },
          stock: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      Sale: {
        type: 'object',
        required: ['id', 'total', 'items'],
        properties: {
          id: { type: 'integer' },
          total: { type: 'number', description: 'Sum of quantity × price over the items' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'integer' },
                sku: { type: 'string' },
                qty: { type: 'integer' },
                price: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    '/api/health': {
      get: { security: [], summary: 'Health check', responses: { '200': { description: 'OK' } } },
    },
    '/api/auth/login': {
      post: {
        security: [],
        summary: 'Log in',
        requestBody: json({
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string' } },
        }),
        responses: {
          '200': {
            description: 'Token',
            ...json({ type: 'object', properties: { token: { type: 'string' } } }),
          },
          '401': err('Invalid credentials'),
        },
      },
    },
    '/api/products': {
      get: {
        summary: 'List or search products',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Products',
            ...json({ type: 'array', items: { $ref: '#/components/schemas/Product' } }),
          },
          '401': err('Not logged in'),
        },
      },
      post: {
        summary: 'Add a product (admins)',
        requestBody: json({ $ref: '#/components/schemas/NewProduct' }),
        responses: {
          '201': { description: 'Created', ...json({ $ref: '#/components/schemas/Product' }) },
          '401': err('Not logged in'),
          '403': err('Not an admin'),
          '422': err('Invalid product (e.g. missing name)'),
        },
      },
    },
    '/api/products/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get: {
        summary: 'One product',
        responses: {
          '200': { description: 'Product', ...json({ $ref: '#/components/schemas/Product' }) },
          '404': err('Not found'),
        },
      },
      delete: {
        summary: 'Delete a product (admins). Its sale lines are removed with it.',
        responses: { '204': { description: 'Deleted' }, '403': err('Not an admin'), '404': err('Not found') },
      },
    },
    '/api/sales': {
      get: {
        summary: 'Recent sales',
        parameters: [{ name: 'expand', in: 'query', schema: { type: 'string', enum: ['items'] } }],
        responses: { '200': { description: 'Sales' } },
      },
      post: {
        summary: 'Record a sale. Stock is reduced; selling more than is in stock is rejected with 422.',
        requestBody: json({
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { product_id: { type: 'integer' }, qty: { type: 'integer', minimum: 1 } },
              },
            },
          },
        }),
        responses: {
          '201': { description: 'Sale', ...json({ $ref: '#/components/schemas/Sale' }) },
          '422': err('Invalid sale or not enough stock'),
        },
      },
    },
    '/api/purchases': {
      post: {
        summary: 'Receive stock (admins)',
        requestBody: json({
          type: 'object',
          required: ['product_id', 'qty'],
          properties: {
            product_id: { type: 'integer' },
            qty: { type: 'integer', minimum: 1 },
            cost: { type: 'number' },
          },
        }),
        responses: {
          '201': { description: 'Purchase with the new stock level' },
          '403': err('Not an admin'),
          '422': err('Invalid purchase'),
        },
      },
    },
    '/api/reports/profit': {
      get: {
        summary: 'Profit per product (admins): profit = revenue − quantity × unit cost',
        responses: {
          '200': { description: 'Report' },
          '401': err('Not logged in'),
          '403': err('Not an admin'),
        },
      },
    },
    '/api/reports/sales': {
      get: { summary: 'Sales per day', responses: { '200': { description: 'Report' } } },
    },
  },
};
