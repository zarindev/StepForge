/** OpenAPI 3 description of the CareClinic REST API (served at /api/openapi.json). */
const Error = {
  type: 'object',
  required: ['error', 'message'],
  properties: { error: { type: 'string' }, message: { type: 'string' } },
};
const Patient = {
  type: 'object',
  required: ['id', 'code', 'full_name', 'dob', 'phone', 'created_at'],
  properties: {
    id: { type: 'integer' },
    code: { type: 'string', pattern: '^PAT-\\d+$' },
    full_name: { type: 'string' },
    dob: { type: 'string', format: 'date' },
    phone: { type: 'string' },
    email: { type: 'string', nullable: true },
    insurance: { type: 'string', nullable: true },
    created_at: { type: 'string' },
  },
};
const Doctor = {
  type: 'object',
  required: ['id', 'name', 'specialty', 'fee'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    specialty: { type: 'string' },
    fee: { type: 'number', minimum: 0 },
  },
};
const Appointment = {
  type: 'object',
  required: ['id', 'patient_id', 'doctor_id', 'date', 'time', 'status'],
  properties: {
    id: { type: 'integer' },
    patient_id: { type: 'integer' },
    doctor_id: { type: 'integer' },
    date: { type: 'string', format: 'date' },
    time: { type: 'string' },
    reason: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['booked', 'cancelled', 'completed'] },
  },
};
const User = {
  type: 'object',
  required: ['id', 'email', 'name', 'role'],
  properties: {
    id: { type: 'integer' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'doctor', 'receptionist'] },
  },
};
const json = (schema: unknown, example?: unknown) => ({
  content: { 'application/json': { schema, ...(example !== undefined && { example }) } },
});
const err = (description: string) => ({ description, ...json({ $ref: '#/components/schemas/Error' }) });
export const TIME_SLOTS = ['09:00', '09:30', '10:00', '10:30', '11:00', '14:00', '14:30', '15:00'];

export const CLINIC_OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'CareClinic API',
    version: '1.0.0',
    description: 'Demo clinic API used to prove StepForge end to end.',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Auth' },
    { name: 'Patients' },
    { name: 'Doctors' },
    { name: 'Appointments' },
    { name: 'System' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['System'],
        operationId: 'health',
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'OK',
            ...json({
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean' }, app: { type: 'string' } },
            }),
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        operationId: 'login',
        summary: 'Log in and get a bearer token',
        security: [],
        requestBody: {
          required: true,
          ...json(
            {
              type: 'object',
              required: ['email', 'password'],
              properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
            },
            { email: 'admin@careclinic.test', password: 'Admin123!' },
          ),
        },
        responses: {
          '200': {
            description: 'Logged in',
            ...json({
              type: 'object',
              required: ['token', 'user'],
              properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' } },
            }),
          },
          '401': err('Invalid credentials'),
        },
      },
    },
    '/api/me': {
      get: {
        tags: ['Auth'],
        operationId: 'me',
        summary: 'Current user',
        responses: {
          '200': { description: 'User', ...json({ $ref: '#/components/schemas/User' }) },
          '401': err('Not logged in'),
        },
      },
    },
    '/api/doctors': {
      get: {
        tags: ['Doctors'],
        operationId: 'listDoctors',
        summary: 'List doctors',
        responses: {
          '200': {
            description: 'Doctors',
            ...json({ type: 'array', items: { $ref: '#/components/schemas/Doctor' } }),
          },
          '401': err('Not logged in'),
        },
      },
    },
    '/api/patients': {
      get: {
        tags: ['Patients'],
        operationId: 'listPatients',
        summary: 'Search patients',
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, example: 'Ana' }],
        responses: {
          '200': {
            description: 'Patients',
            ...json({ type: 'array', items: { $ref: '#/components/schemas/Patient' } }),
          },
          '401': err('Not logged in'),
        },
      },
      post: {
        tags: ['Patients'],
        operationId: 'createPatient',
        summary: 'Register a patient',
        requestBody: {
          required: true,
          ...json(
            {
              type: 'object',
              required: ['full_name', 'dob', 'phone'],
              properties: {
                full_name: { type: 'string' },
                dob: { type: 'string', format: 'date' },
                phone: { type: 'string' },
                email: { type: 'string', format: 'email' },
                insurance: { type: 'string' },
              },
            },
            {
              full_name: 'Grace Hopper',
              dob: '1985-12-09',
              phone: '+1-555-201-0099',
              email: 'grace@example.test',
              insurance: 'BlueCross',
            },
          ),
        },
        responses: {
          '201': { description: 'Created', ...json({ $ref: '#/components/schemas/Patient' }) },
          '401': err('Not logged in'),
          '409': err('A patient with the same name and date of birth is already registered'),
          '422': err('Validation error'),
        },
      },
    },
    '/api/patients/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
      get: {
        tags: ['Patients'],
        operationId: 'getPatient',
        summary: 'Get a patient',
        responses: {
          '200': { description: 'Patient', ...json({ $ref: '#/components/schemas/Patient' }) },
          '401': err('Not logged in'),
          '404': err('Not found'),
        },
      },
      delete: {
        tags: ['Patients'],
        operationId: 'deletePatient',
        summary: 'Delete a patient (admin)',
        description: 'Deletes the patient together with their appointments.',
        responses: {
          '204': { description: 'Deleted' },
          '401': err('Not logged in'),
          '403': err('Admins only'),
          '404': err('Not found'),
        },
      },
    },
    '/api/appointments': {
      get: {
        tags: ['Appointments'],
        operationId: 'listAppointments',
        summary: 'List appointments',
        responses: {
          '200': {
            description: 'Appointments',
            ...json({ type: 'array', items: { $ref: '#/components/schemas/Appointment' } }),
          },
          '401': err('Not logged in'),
        },
      },
      post: {
        tags: ['Appointments'],
        operationId: 'bookAppointment',
        summary: 'Book an appointment',
        requestBody: {
          required: true,
          ...json(
            {
              type: 'object',
              required: ['patient_id', 'doctor_id', 'date', 'time'],
              properties: {
                patient_id: { type: 'integer' },
                doctor_id: { type: 'integer' },
                date: { type: 'string', format: 'date' },
                time: { type: 'string', enum: TIME_SLOTS },
                reason: { type: 'string' },
              },
            },
            { patient_id: 2, doctor_id: 3, date: '2026-12-01', time: '09:30', reason: 'Check-up' },
          ),
        },
        responses: {
          '201': { description: 'Booked', ...json({ $ref: '#/components/schemas/Appointment' }) },
          '401': err('Not logged in'),
          '409': err('Doctor already booked'),
          '422': err('Validation error'),
        },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: { Error, Patient, Doctor, Appointment, User },
  },
};
