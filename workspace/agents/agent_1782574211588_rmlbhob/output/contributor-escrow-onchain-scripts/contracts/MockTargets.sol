// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Simulation target only. Never deploy this contract to a shared network.
contract MockEAS {
    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    function attest(AttestationRequest calldata request)
        external
        payable
        returns (bytes32)
    {
        require(msg.value == request.data.value, "value mismatch");
        return keccak256(abi.encode(request));
    }
}

/// @dev Stateless simulation target matching the design-only escrow interface.
contract MockEscrow {
    function release(uint256, uint32) external pure {}
    function refund(uint256, uint32) external pure {}

    function raiseDispute(uint256, uint32, bytes32 reasonHash, bytes32 evidenceHash)
        external
        pure
    {
        require(reasonHash != bytes32(0), "zero reason");
        require(evidenceHash != bytes32(0), "zero evidence");
    }
}
