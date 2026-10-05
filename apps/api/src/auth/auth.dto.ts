import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,128}$/;

export class RegisterDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ description: 'Min 10 chars with upper, lower and a digit' })
  @IsString()
  @Matches(PASSWORD_RULE, { message: 'Password must be 10-128 characters and include upper-case, lower-case and a digit' })
  password!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) organizationName?: string;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(128) password!: string;
}

export class AcceptInviteDto {
  @ApiProperty() @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty()
  @IsString()
  @Matches(PASSWORD_RULE, { message: 'Password must be 10-128 characters and include upper-case, lower-case and a digit' })
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(128) currentPassword!: string;
  @ApiProperty()
  @IsString()
  @Matches(PASSWORD_RULE, { message: 'Password must be 10-128 characters and include upper-case, lower-case and a digit' })
  newPassword!: string;
}
