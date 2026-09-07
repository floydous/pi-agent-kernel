// C fixture: realistic packet parser with buffer state and multiple helpers.
#include <stdio.h>
#include <string.h>
#include <stdint.h>

#define BUFFER_SIZE 4096
#define HEADER_MAGIC 0xDEADBEEF

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t length;
    uint32_t payload_checksum;
} packet_header_t;

int compute_checksum(const char *data, int len) {
    if (!data || len <= 0) return -1;
    int sum = 0;
    for (int i = 0; i < len; ++i) {
        sum = (sum + (unsigned char)data[i]) & 0xFF;
    }
    return sum;
}

int parse_packet(const uint8_t *raw, int raw_len, packet_header_t *out) {
    if (!raw || !out || raw_len < (int)sizeof(packet_header_t)) {
        return -1;
    }
    memcpy(out, raw, sizeof(packet_header_t));
    if (out->magic != HEADER_MAGIC) {
        return 0;
    }
    if (out->length > raw_len - (int)sizeof(packet_header_t)) {
        return -1;
    }
    return 1;
}

int encode_response(uint8_t *buf, int buf_size, const char *payload, int payload_len) {
    if (!buf || buf_size < (int)sizeof(packet_header_t) + payload_len) {
        return -1;
    }
    packet_header_t hdr = {
        .magic = HEADER_MAGIC,
        .version = 1,
        .length = (uint16_t)payload_len,
        .payload_checksum = 0,
    };
    hdr.payload_checksum = compute_checksum(payload, payload_len);
    memcpy(buf, &hdr, sizeof(packet_header_t));
    memcpy(buf + sizeof(packet_header_t), payload, payload_len);
    return (int)sizeof(packet_header_t) + payload_len;
}
