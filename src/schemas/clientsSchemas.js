const Joi = require("joi");

const vehiclePostSchema = Joi.object({
  brand: Joi.string().max(50).required().messages({
    "string.base": "Brand must be text",
    "string.empty": "Brand is required",
    "string.max": "Brand cannot exceed 50 characters",
    "any.required": "Brand is required",
  }),
  model: Joi.string().max(50).required().messages({
    "string.base": "Model must be text",
    "string.empty": "Model is required",
    "string.max": "Model cannot exceed 50 characters",
    "any.required": "Model is required",
  }),
  year: Joi.number()
    .integer()
    .min(1900)
    .max(new Date().getFullYear())
    .required()
    .messages({
      "number.base": "Year must be a number",
      "number.integer": "Year must be an integer",
      "number.min": "Vehicle year cannot be less than 1900",
      "number.max": `Vehicle year cannot be greater than ${new Date().getFullYear()}`,
      "any.required": "Year is required",
    }),
  color: Joi.string().max(50).required().messages({
    "string.base": "Color must be text",
    "string.empty": "Color is required",
    "string.max": "Color cannot exceed 50 characters",
    "any.required": "Color is required",
  }),
  license_plate: Joi.string().max(20).required().messages({
    "string.base": "License plate must be text",
    "string.empty": "License plate is required",
    "string.max": "License plate cannot exceed 20 characters",
    "any.required": "License plate is required",
  }),
});

const postClientSchema = Joi.object({
  first_name: Joi.string().max(100).required().messages({
    "string.base": "First name must be text",
    "string.empty": "First name is required",
    "string.max": "First name cannot exceed 100 characters",
    "any.required": "First name is required",
  }),
  last_name: Joi.string().max(100).required().messages({
    "string.base": "Last name must be text",
    "string.empty": "Last name is required",
    "string.max": "Last name cannot exceed 100 characters",
    "any.required": "Last name is required",
  }),
  email: Joi.string().email().required().messages({
    "string.base": "Email must be text",
    "string.email": "Email is not valid",
    "string.empty": "Email is required",
    "any.required": "Email is required",
  }),
  phone: Joi.string()
    .regex(/^[0-9+]+$/)
    .max(20)
    .required()
    .messages({
      "string.pattern.base": "Phone can only contain numbers and the '+' sign",
      "string.empty": "Phone is required",
      "string.max": "Phone cannot exceed 20 characters",
      "any.required": "Phone is required",
    }),
  created_by: Joi.number().integer().forbidden().messages({
    "any.unknown": "Cannot send created_by field",
  }),
  // Vehicles are now optional
  vehicles: Joi.array().items(vehiclePostSchema).optional(),
});

// Vehículo PUT
const vehiclePutSchema = Joi.object({
  id: Joi.number().integer().optional(),
  brand: Joi.string().max(50).optional().messages({
    "string.base": "Brand must be text",
    "string.max": "Brand cannot exceed 50 characters",
  }),
  model: Joi.string().max(50).optional().messages({
    "string.base": "Model must be text",
    "string.max": "Model cannot exceed 50 characters",
  }),
  year: Joi.number()
    .integer()
    .min(1900)
    .max(new Date().getFullYear())
    .optional()
    .messages({
      "number.base": "Year must be a number",
      "number.integer": "Year must be an integer",
      "number.min": "Vehicle year cannot be less than 1900",
      "number.max": `Vehicle year cannot be greater than ${new Date().getFullYear()}`,
    }),
  color: Joi.string().max(50).optional().messages({
    "string.base": "Color must be text",
    "string.max": "Color cannot exceed 50 characters",
  }),
  license_plate: Joi.string().max(20).optional().messages({
    "string.base": "License plate must be text",
    "string.max": "License plate cannot exceed 20 characters",
  }),
  deleted: Joi.boolean().optional(),
});

// PUT Cliente
const putClientSchema = Joi.object({
  first_name: Joi.string().max(100).optional().messages({
    "string.base": "First name must be text",
    "string.max": "First name cannot exceed 100 characters",
  }),
  last_name: Joi.string().max(100).optional().messages({
    "string.base": "Last name must be text",
    "string.max": "Last name cannot exceed 100 characters",
  }),
  email: Joi.string().email().optional().messages({
    "string.base": "Email must be text",
    "string.email": "Email is not valid",
  }),
  phone: Joi.string().max(20).optional().messages({
    "string.base": "Phone must be text",
    "string.max": "Phone cannot exceed 20 characters",
  }),
  updated_by: Joi.number().integer().forbidden().messages({
    "any.unknown": "Cannot send updated_by field",
  }),
  vehicles: Joi.array().items(vehiclePutSchema).optional(),
});

const getClientByIdSchema = Joi.object({
  id: Joi.number().integer().required().messages({
    "number.base": "ID must be a number",
    "number.integer": "ID must be an integer",
    "any.required": "ID is required",
  }),
});

const getClientsSchema = Joi.object({
  search: Joi.string().optional().messages({
    "string.base": "Search term must be text",
  }),
});

module.exports = {
  postClientSchema,
  putClientSchema,
  getClientByIdSchema,
  getClientsSchema,
};
