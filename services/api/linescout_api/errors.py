"""Structured error responses shared by every router."""

from __future__ import annotations

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from linescout_api.schemas import ErrorDetail, ErrorResponse


class ApiError(HTTPException):
    """HTTPException whose detail is always an :class:`ErrorResponse` payload."""

    def __init__(self, status_code: int, code: str, message: str, field: str | None = None) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.code = code
        self.message = message
        self.field = field

    def to_response(self) -> JSONResponse:
        payload = ErrorResponse(
            error=ErrorDetail(code=self.code, message=self.message, field=self.field)
        )
        return JSONResponse(status_code=self.status_code, content=payload.model_dump())


def bad_request(code: str, message: str, field: str | None = None) -> ApiError:
    return ApiError(400, code, message, field)


def too_large(code: str, message: str, field: str | None = None) -> ApiError:
    return ApiError(413, code, message, field)


def unprocessable(code: str, message: str, field: str | None = None) -> ApiError:
    return ApiError(422, code, message, field)


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


async def api_error_handler(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, ApiError)
    return error.to_response()


async def http_error_handler(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, HTTPException)
    payload = ErrorResponse(
        error=ErrorDetail(code=f"http_{error.status_code}", message=str(error.detail))
    )
    return JSONResponse(
        status_code=error.status_code, content=payload.model_dump(), headers=error.headers
    )


async def validation_error_handler(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, RequestValidationError)
    first = error.errors()[0] if error.errors() else {}
    location = ".".join(
        str(part) for part in first.get("loc", ()) if part not in ("body", "query", "path")
    )
    payload = ErrorResponse(
        error=ErrorDetail(
            code="validation_error",
            message=str(first.get("msg", "invalid request")),
            field=location or None,
        )
    )
    return JSONResponse(status_code=422, content=payload.model_dump())
