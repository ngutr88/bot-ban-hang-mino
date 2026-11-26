export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ErrorFieldDetail {
  field: string;
  reason: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly fields?: ErrorFieldDetail[];

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    fields?: ErrorFieldDetail[]
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}

export function validationError(
  message = "Thông tin gửi lên chưa hợp lệ.",
  fields?: ErrorFieldDetail[]
): AppError {
  return new AppError(400, "VALIDATION_ERROR", message, fields);
}

export function unauthenticatedError(
  message = "Vui lòng đăng nhập để tiếp tục."
): AppError {
  return new AppError(401, "UNAUTHENTICATED", message);
}

export function forbiddenError(
  message = "Yêu cầu bị từ chối do không đủ quyền hoặc nguồn gửi không hợp lệ."
): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function notFoundError(
  message = "Không tìm thấy dữ liệu yêu cầu."
): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function conflictError(
  message = "Trạng thái dữ liệu hiện tại không cho phép thao tác này."
): AppError {
  return new AppError(409, "CONFLICT", message);
}

export function serviceUnavailableError(
  message = "Hệ thống tạm thời chưa sẵn sàng."
): AppError {
  return new AppError(503, "SERVICE_UNAVAILABLE", message);
}
