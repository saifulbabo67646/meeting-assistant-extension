export function canonicalizeHeaderFieldValue(value) {
    // https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-message-signatures-08#section-2.1
    // https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-messaging-19#section-5.2
    return value.trim().replace(/[ \t]*\r\n[ \t]+/g, ' ');
}

export function queryCanonicalizedHeaderField(headers, name) {
    const field = headers[name];
    return field ? Array.isArray(field) ? field.map(canonicalizeHeaderFieldValue).join(', ') : canonicalizeHeaderFieldValue(field) : null;
}

export function getClientIP(headers) {
    const xforward = queryCanonicalizedHeaderField(headers, 'x-forwarded-for');
    return xforward ? xforward.split(',').length > 0 ? xforward.split(',')[0] : 'unknown' : 'unknown';
}