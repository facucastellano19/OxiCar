const Joi = require('joi');

const loginSchema = Joi.object({
    username: Joi.string()
        .required()
        .messages({
            'any.required': 'Username is required',
            'string.empty': 'Username cannot be empty'
        }),

    password: Joi.string()
        .required()
        .messages({
            'any.required': 'Password is required',
            'string.empty': 'Password cannot be empty'
        }),
});

const registerSchema = Joi.object({
    name: Joi.string()
        .min(3)
        .max(50)
        .required()
        .messages({
            'string.min': 'Name must be at least 3 characters long',
            'string.max': 'Name must be at most 50 characters long',
            'any.required': 'Name is required'
        }),

    email: Joi.string()
        .email()
        .required()
        .messages({
            'string.email': 'Email must be a valid email address',
            'any.required': 'Email is required'
        }),

    username: Joi.string()
        .alphanum()
        .min(3)
        .max(30)
        .required()
        .messages({
            'string.alphanum': 'Username must be alphanumeric',
            'string.min': 'Username must be at least 3 characters long',
            'string.max': 'Username must be at most 30 characters long',
            'any.required': 'Username is required'
        }),

    password: Joi.string()
        .pattern(new RegExp('^[a-zA-Z0-9!@#$%^&*()_+{}\\[\\]:;<>,.?~\\\\/-]+$'))
        .min(8)
        .max(30)
        .required()
        .messages({
            'string.pattern.base': 'Password must be alphanumeric and can include special characters',
            'string.min': 'Password must be at least 8 characters long',
            'string.max': 'Password must be at most 30 characters long',
            'any.required': 'Password is required'
        }),

    role_id: Joi.number()
        .integer()
        .messages({
            'number.base': 'Role ID must be a number',
            'number.integer': 'Role ID must be an integer',
            'any.required': 'Role ID is required'
        }),
    created_by: Joi.number()
        .integer()
        .messages({
            'number.base': 'Created by must be a number',
            'number.integer': 'Created by must be an integer',
        }),
});

module.exports = { loginSchema, registerSchema };